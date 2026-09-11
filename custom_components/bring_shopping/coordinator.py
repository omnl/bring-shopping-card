"""DataUpdateCoordinator for the Bring! Shopping Card integration."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
import logging
from time import monotonic
from typing import Any

from bring_api import (
    Bring,
    BringAuthException,
    BringItemOperation,
    BringList,
    BringRequestException,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .helpers import (
    load_section_translations,
    translate_section,
    get_image_url,
    get_icon_for_item,
)

_LOGGER = logging.getLogger(__name__)
MUTATION_REFRESH_DELAY = 15
PENDING_MUTATION_TTL = 35
MUTATION_TIMEOUT = 20


@dataclass
class BringItem:
    """Representation of a shopping list item."""

    name: str
    original_name: str
    specification: str
    icon: str
    image_url: str | None
    category: str


@dataclass
class BringListData:
    """Data for a single Bring! list."""

    list_uuid: str
    name: str
    purchase: list[BringItem] = field(default_factory=list)
    recently: list[BringItem] = field(default_factory=list)
    available: list[BringItem] = field(default_factory=list)


@dataclass
class BringData:
    """Coordinator data containing all lists."""

    lists: dict[str, BringListData] = field(default_factory=dict)


@dataclass
class PendingMutation:
    """A successful write that has not yet appeared in a Bring read."""

    operation: str
    item: BringItem
    created_at: float = field(default_factory=monotonic)


class BringDataUpdateCoordinator(DataUpdateCoordinator[BringData]):
    """Class to manage fetching Bring data."""

    def __init__(
        self,
        hass: HomeAssistant,
        bring: Bring,
    ) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=UPDATE_INTERVAL),
        )
        self.bring = bring
        self._lists_info: list[BringList] = []
        self._mutation_refresh_task: asyncio.Task[None] | None = None
        self._mutation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._pending_mutations: dict[tuple[str, str], PendingMutation] = {}
        self._refresh_lock = asyncio.Lock()

    def _mutation_lock(self, list_uuid: str, item_name: str) -> asyncio.Lock:
        """Preserve order for one item without blocking unrelated items."""
        key = (list_uuid, item_name)
        if key not in self._mutation_locks:
            self._mutation_locks[key] = asyncio.Lock()
        return self._mutation_locks[key]

    def async_shutdown(self) -> None:
        """Cancel background work when the config entry unloads."""
        if self._mutation_refresh_task and not self._mutation_refresh_task.done():
            self._mutation_refresh_task.cancel()

    def _set_list_data(self, list_data: BringListData) -> None:
        """Publish one locally mutated list without waiting for a cloud refresh."""
        if not self.data:
            return
        self.async_set_updated_data(
            BringData(lists={**self.data.lists, list_data.list_uuid: list_data})
        )

    def _apply_pending_mutations(
        self, data: BringData, freshly_fetched: set[str]
    ) -> BringData:
        """Overlay successful writes until Bring reads confirm their final state."""
        for key, mutation in list(self._pending_mutations.items()):
            list_uuid, item_name = key
            if monotonic() - mutation.created_at >= PENDING_MUTATION_TTL:
                del self._pending_mutations[key]
                continue
            list_data = data.lists.get(list_uuid)
            if list_data is None:
                continue

            # A fallback to self.data is not proof that Bring has applied the
            # write: it already contains our optimistic projection.
            can_confirm = list_uuid in freshly_fetched

            purchase_item = next(
                (item for item in list_data.purchase if item.original_name == item_name),
                None,
            )
            recent_item = next(
                (item for item in list_data.recently if item.original_name == item_name),
                None,
            )

            if mutation.operation in ("add", "update"):
                if can_confirm and (
                    purchase_item is not None
                    and purchase_item.specification == mutation.item.specification
                ):
                    del self._pending_mutations[key]
                    continue
                purchase = [
                    item for item in list_data.purchase
                    if item.original_name != item_name
                ]
                purchase.append(mutation.item)
                recently = [
                    item for item in list_data.recently
                    if item.original_name != item_name
                ]
                available = [
                    item for item in list_data.available
                    if item.original_name != item_name
                ]
            elif mutation.operation == "complete":
                if can_confirm and purchase_item is None:
                    del self._pending_mutations[key]
                    continue
                purchase = [
                    item for item in list_data.purchase
                    if item.original_name != item_name
                ]
                recently = [
                    mutation.item,
                    *[
                        item for item in list_data.recently
                        if item.original_name != item_name
                    ],
                ]
                available = list_data.available
                if not any(item.original_name == item_name for item in available):
                    available = [mutation.item, *available]
                    available.sort(key=lambda item: (item.category or "ZZZ", item.name))
            else:  # remove
                if can_confirm and purchase_item is None and recent_item is None:
                    del self._pending_mutations[key]
                    continue
                purchase = [
                    item for item in list_data.purchase
                    if item.original_name != item_name
                ]
                recently = [
                    item for item in list_data.recently
                    if item.original_name != item_name
                ]
                available = [
                    item for item in list_data.available
                    if item.original_name != item_name
                ]

            data.lists[list_uuid] = BringListData(
                list_uuid=list_data.list_uuid,
                name=list_data.name,
                purchase=purchase,
                recently=recently,
                available=available,
            )
        return data

    def _schedule_mutation_refresh(self) -> None:
        """Schedule bounded reconciliation without starving during write bursts."""
        if self._mutation_refresh_task and not self._mutation_refresh_task.done():
            return
        self._mutation_refresh_task = self.hass.async_create_task(
            self._async_refresh_after_mutations()
        )

    async def _async_refresh_after_mutations(self) -> None:
        """Synchronize after a quiet mutation window without blocking commands."""
        try:
            attempts = 0
            while self._pending_mutations and attempts < 3:
                oldest_age = max(
                    monotonic() - mutation.created_at
                    for mutation in self._pending_mutations.values()
                )
                delay = min(
                    MUTATION_REFRESH_DELAY,
                    max(0.1, PENDING_MUTATION_TTL - oldest_age + 0.1),
                )
                await asyncio.sleep(delay)
                await self.async_refresh()
                attempts += 1
        except asyncio.CancelledError:
            return
        except Exception as err:  # noqa: BLE001 - keep background refresh failures isolated
            _LOGGER.warning("Delayed Bring refresh failed: %s", err)
        finally:
            if self._mutation_refresh_task is asyncio.current_task():
                self._mutation_refresh_task = None

    async def _async_update_data(self) -> BringData:
        """Serialize and bound full account refreshes."""
        async with self._refresh_lock:
            async with asyncio.timeout(60):
                return await self._async_update_data_unlocked()

    async def _async_update_data_unlocked(self) -> BringData:
        """Fetch data from Bring API."""
        try:
            # Get all lists
            lists_response = await self.bring.load_lists()
            self._lists_info = lists_response.lists

            data = BringData()
            freshly_fetched: set[str] = set()

            # Fetch data for each list
            for list_info in self._lists_info:
                list_uuid = list_info.listUuid
                list_name = list_info.name

                if not list_uuid:
                    continue

                try:
                    list_data = await self._fetch_list_data(list_uuid, list_name)
                    data.lists[list_uuid] = list_data
                    freshly_fetched.add(list_uuid)
                except Exception as err:
                    _LOGGER.error(
                        "Failed to fetch data for list %s (%s): %s",
                        list_name,
                        list_uuid,
                        err,
                    )
                    # Don't let a single unparseable item (e.g. a flyer/offer item)
                    # make the whole list disappear from the card. Fall back to the
                    # last known good data for this list if we have it.
                    previous = (
                        self.data.lists.get(list_uuid) if self.data else None
                    )
                    if previous is not None:
                        data.lists[list_uuid] = previous

            return self._apply_pending_mutations(data, freshly_fetched)

        except BringAuthException as err:
            _LOGGER.error("Authentication error with Bring API: %s", err)
            raise UpdateFailed(f"Authentication failed: {err}") from err
        except BringRequestException as err:
            _LOGGER.error("Request error with Bring API: %s", err)
            raise UpdateFailed(f"Failed to fetch data: {err}") from err
        except Exception as err:
            _LOGGER.error("Unexpected error fetching Bring data: %s", err)
            raise UpdateFailed(f"Unexpected error: {err}") from err

    def _list_locale(self, list_uuid: str) -> str:
        """Determine the article language configured for a list in Bring."""
        settings = getattr(self.bring, "user_list_settings", None) or {}
        entry = settings.get(list_uuid) or {}
        return entry.get("listArticleLanguage") or getattr(
            self.bring, "user_locale", "de-CH"
        )

    async def _fetch_list_data(
        self, list_uuid: str, list_name: str
    ) -> BringListData:
        """Fetch data for a single list."""
        # Get items
        items_response = await self.bring.get_list(list_uuid)

        # Category ids come back as canonical German keys; localize them to the
        # list's language using Bring's own translation files (cached).
        locale = self._list_locale(list_uuid)
        sections = await self.hass.async_add_executor_job(
            load_section_translations, locale
        )

        # Get all item details (for images and categories). These are optional
        # enrichment; if they fail to load or parse we still show the list with
        # its items rather than dropping everything.
        try:
            details_response = await self.bring.get_all_item_details(list_uuid)
            details_items = details_response.items
        except Exception as err:
            _LOGGER.warning(
                "Failed to fetch item details for list %s (%s); "
                "showing items without images/categories: %s",
                list_name,
                list_uuid,
                err,
            )
            details_items = []
        details_map = {d.itemId: d for d in details_items}
        previous = self.data.lists.get(list_uuid) if self.data else None
        cached_items = {
            item.original_name: item
            for item in (
                [*previous.purchase, *previous.recently, *previous.available]
                if previous else []
            )
        }

        # Process purchase items
        purchase_items = []
        for item in items_response.items.purchase:
            item_id = item.itemId
            detail = details_map.get(item_id)
            cached = cached_items.get(item_id)

            icon_item_id = detail.userIconItemId if detail else item_id
            category = detail.userSectionId if detail else ""
            image_url = get_image_url(icon_item_id or item_id)

            purchase_items.append(
                BringItem(
                    name=item_id,
                    original_name=item_id,
                    specification=item.specification or "",
                    icon=(
                        cached.icon
                        if cached and not detail
                        else get_icon_for_item(item_id, icon_item_id, category)
                    ),
                    image_url=(cached.image_url if cached and not detail else image_url),
                    category=(
                        cached.category
                        if cached and not detail
                        else translate_section(category, sections)
                    ),
                )
            )

        # Process recently items (limit to 20)
        recently_items = []
        for item in items_response.items.recently[:20]:
            item_id = item.itemId
            detail = details_map.get(item_id)
            cached = cached_items.get(item_id)

            icon_item_id = detail.userIconItemId if detail else item_id
            category = detail.userSectionId if detail else ""
            image_url = get_image_url(icon_item_id or item_id)

            recently_items.append(
                BringItem(
                    name=item_id,
                    original_name=item_id,
                    specification=item.specification or "",
                    icon=(
                        cached.icon
                        if cached and not detail
                        else get_icon_for_item(item_id, icon_item_id, category)
                    ),
                    image_url=(cached.image_url if cached and not detail else image_url),
                    category=(
                        cached.category
                        if cached and not detail
                        else translate_section(category, sections)
                    ),
                )
            )

        # Process available items (all known items not in purchase)
        purchase_names = {item.itemId for item in items_response.items.purchase}
        available_items = []
        seen = set()

        for detail in details_items:
            item_id = detail.itemId
            if item_id and item_id not in seen and item_id not in purchase_names:
                seen.add(item_id)
                category = detail.userSectionId
                icon_item_id = detail.userIconItemId or item_id
                image_url = get_image_url(icon_item_id)

                available_items.append(
                    BringItem(
                        name=item_id,
                        original_name=item_id,
                        specification="",
                        icon=get_icon_for_item(item_id, icon_item_id, category),
                        image_url=image_url,
                        category=translate_section(category, sections),
                    )
                )

        if not details_items and previous:
            for cached in [*previous.available, *previous.recently]:
                if cached.original_name in seen or cached.original_name in purchase_names:
                    continue
                seen.add(cached.original_name)
                available_items.append(cached)

        # Sort available by category
        available_items.sort(key=lambda x: (x.category or "ZZZ", x.name))

        return BringListData(
            list_uuid=list_uuid,
            name=list_name,
            purchase=purchase_items,
            recently=recently_items,
            available=available_items,
        )

    def get_lists_info(self) -> list[dict[str, Any]]:
        """Get basic info about all lists (for the card's list selector)."""
        return [
            {
                "uuid": lst.listUuid,
                "name": lst.name,
            }
            for lst in self._lists_info
            if lst.listUuid
        ]

    def owns_list(self, list_uuid: str) -> bool:
        """Return whether the Bring account reports this list."""
        return any(item.listUuid == list_uuid for item in self._lists_info)

    async def async_refresh_list(self, list_uuid: str) -> bool:
        """Fetch one list from Bring and publish it without refreshing all accounts."""
        current = self.data.lists.get(list_uuid) if self.data else None
        list_info = next(
            (item for item in self._lists_info if item.listUuid == list_uuid),
            None,
        )
        if current is None and list_info is None:
            return False
        list_name = current.name if current else list_info.name
        try:
            async with self._refresh_lock:
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    fresh = await self._fetch_list_data(list_uuid, list_name)
                merged = self._apply_pending_mutations(
                    BringData(lists={list_uuid: fresh}),
                    {list_uuid},
                )
                self._set_list_data(merged.lists[list_uuid])
            return True
        except Exception as err:
            _LOGGER.warning("Failed to refresh list %s: %s", list_uuid, err)
            return False

    @staticmethod
    def _cached_item(
        current: BringListData, item_name: str, specification: str = ""
    ) -> BringItem:
        """Return cached presentation data or a safe fallback for an item."""
        source = next(
            (
                item
                for item in [
                    *current.purchase,
                    *current.available,
                    *current.recently,
                ]
                if item.original_name == item_name
            ),
            None,
        )
        return BringItem(
            name=source.name if source else item_name,
            original_name=item_name,
            specification=specification,
            icon=source.icon if source else get_icon_for_item(item_name),
            image_url=source.image_url if source else get_image_url(item_name),
            category=source.category if source else "",
        )

    async def async_add_item(
        self,
        list_uuid: str,
        item_name: str,
        specification: str = "",
    ) -> bool:
        """Add an item to a shopping list."""
        try:
            async with self._mutation_lock(list_uuid, item_name):
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    await self.bring.save_item(list_uuid, item_name, specification)
                current = self.data.lists.get(list_uuid) if self.data else None
                if current:
                    added_item = self._cached_item(current, item_name, specification)
                    self._pending_mutations[(list_uuid, item_name)] = PendingMutation(
                        operation="add",
                        item=added_item,
                    )
                    purchase = [
                        item for item in current.purchase if item.original_name != item_name
                    ]
                    purchase.append(added_item)
                    self._set_list_data(
                        BringListData(
                            list_uuid=current.list_uuid,
                            name=current.name,
                            purchase=purchase,
                            recently=[
                                item for item in current.recently
                                if item.original_name != item_name
                            ],
                            available=[
                                item for item in current.available
                                if item.original_name != item_name
                            ],
                        )
                    )
                self._schedule_mutation_refresh()
            return True
        except Exception as err:
            _LOGGER.error("Failed to add item %s: %s", item_name, err)
            return False

    async def async_complete_item(
        self,
        list_uuid: str,
        item_name: str,
    ) -> bool:
        """Mark an item as completed (move to recently)."""
        try:
            async with self._mutation_lock(list_uuid, item_name):
                current = self.data.lists.get(list_uuid) if self.data else None
                completed_item = (
                    self._cached_item(current, item_name) if current else None
                )
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    await self.bring.complete_item(
                        list_uuid,
                        item_name,
                        completed_item.specification if completed_item else "",
                    )
                current = self.data.lists.get(list_uuid) if self.data else None
                if current:
                    completed_item = completed_item or self._cached_item(current, item_name)
                    self._pending_mutations[(list_uuid, item_name)] = PendingMutation(
                        operation="complete",
                        item=completed_item,
                    )
                    purchase = [
                        item for item in current.purchase
                        if item.original_name != item_name
                    ]
                    recently = [
                        completed_item,
                        *[item for item in current.recently if item.original_name != item_name],
                    ]
                    available = current.available
                    if not any(item.original_name == item_name for item in available):
                        available = [completed_item, *available]
                        available.sort(key=lambda item: (item.category or "ZZZ", item.name))
                    self._set_list_data(
                        BringListData(
                            list_uuid=current.list_uuid,
                            name=current.name,
                            purchase=purchase,
                            recently=recently,
                            available=available,
                        )
                    )
                self._schedule_mutation_refresh()
            return True
        except Exception as err:
            _LOGGER.error("Failed to complete item %s: %s", item_name, err)
            return False

    async def async_complete_items(
        self,
        list_uuid: str,
        item_names: list[str],
    ) -> bool:
        """Complete multiple items atomically with Bring's batch endpoint."""
        unique_names = list(dict.fromkeys(name for name in item_names if name))
        if not unique_names:
            return True

        try:
            async with self._mutation_lock(list_uuid, "*"):
                current = self.data.lists.get(list_uuid) if self.data else None
                completed_items = {
                    name: self._cached_item(current, name)
                    for name in unique_names
                } if current else {}
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    await self.bring.batch_update_list(
                        list_uuid,
                        [
                            {
                                "itemId": name,
                                "spec": completed_items[name].specification
                                if name in completed_items else "",
                            }
                            for name in unique_names
                        ],
                        BringItemOperation.COMPLETE,
                    )

                current = self.data.lists.get(list_uuid) if self.data else None
                if current:
                    completed_items = completed_items or {
                        name: self._cached_item(current, name)
                        for name in unique_names
                    }
                    for name, item in completed_items.items():
                        self._pending_mutations[(list_uuid, name)] = PendingMutation(
                            operation="complete",
                            item=item,
                        )

                    names = set(unique_names)
                    purchase = [
                        item for item in current.purchase
                        if item.original_name not in names
                    ]
                    recently = [
                        *completed_items.values(),
                        *[
                            item for item in current.recently
                            if item.original_name not in names
                        ],
                    ]
                    available = list(current.available)
                    available_names = {
                        item.original_name for item in available
                    }
                    available.extend(
                        item
                        for name, item in completed_items.items()
                        if name not in available_names
                    )
                    available.sort(key=lambda item: (item.category or "ZZZ", item.name))
                    self._set_list_data(
                        BringListData(
                            list_uuid=current.list_uuid,
                            name=current.name,
                            purchase=purchase,
                            recently=recently,
                            available=available,
                        )
                    )
                self._schedule_mutation_refresh()
            return True
        except Exception as err:
            _LOGGER.error("Failed to complete %s items: %s", len(unique_names), err)
            return False

    async def async_update_item(
        self,
        list_uuid: str,
        item_name: str,
        specification: str,
    ) -> bool:
        """Update an item's specification."""
        try:
            async with self._mutation_lock(list_uuid, item_name):
                # save_item with same name updates the specification
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    await self.bring.save_item(list_uuid, item_name, specification)
                current = self.data.lists.get(list_uuid) if self.data else None
                if current:
                    updated_item = self._cached_item(current, item_name, specification)
                    self._pending_mutations[(list_uuid, item_name)] = PendingMutation(
                        operation="update",
                        item=updated_item,
                    )
                    purchase = [
                        updated_item if item.original_name == item_name else item
                        for item in current.purchase
                    ]
                    if not any(item.original_name == item_name for item in purchase):
                        purchase.append(updated_item)
                    self._set_list_data(
                        BringListData(
                            list_uuid=current.list_uuid,
                            name=current.name,
                            purchase=purchase,
                            recently=current.recently,
                            available=current.available,
                        )
                    )
                self._schedule_mutation_refresh()
            return True
        except Exception as err:
            _LOGGER.error("Failed to update item %s: %s", item_name, err)
            return False

    async def async_remove_item(
        self,
        list_uuid: str,
        item_name: str,
    ) -> bool:
        """Remove an item from the list."""
        try:
            async with self._mutation_lock(list_uuid, item_name):
                async with asyncio.timeout(MUTATION_TIMEOUT):
                    await self.bring.remove_item(list_uuid, item_name)
                current = self.data.lists.get(list_uuid) if self.data else None
                if current:
                    removed_item = self._cached_item(current, item_name)
                    self._pending_mutations[(list_uuid, item_name)] = PendingMutation(
                        operation="remove",
                        item=removed_item,
                    )
                    self._set_list_data(
                        BringListData(
                            list_uuid=current.list_uuid,
                            name=current.name,
                            purchase=[
                                item for item in current.purchase
                                if item.original_name != item_name
                            ],
                            recently=[
                                item for item in current.recently
                                if item.original_name != item_name
                            ],
                            available=[
                                item for item in current.available
                                if item.original_name != item_name
                            ],
                        )
                    )
                self._schedule_mutation_refresh()
            return True
        except Exception as err:
            _LOGGER.error("Failed to remove item %s: %s", item_name, err)
            return False
