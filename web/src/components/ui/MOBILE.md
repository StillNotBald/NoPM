# Mobile shell primitives — quick adoption

FilterSheet: wrap the existing filter row, unchanged, and pass an active-filter count.

```tsx
<FilterSheet activeCount={activeFilterCount} onClear={clearFilters}>
  <SearchInput ... /><StatusSelect ... /><DateRangeFields ... />
</FilterSheet>
```

At `md`+ it renders `children` inline exactly as today. Below `md` it becomes one 44px "Filters" button that opens the same children in a bottom sheet with a sticky Apply/Clear footer.

DataList: replace a hand-rolled `<table>` with column defs; mark one column `primary`, status/priority columns `badge`.

```tsx
<DataList
  columns={[
    { key: "title", header: "Title", cell: (r) => r.title, primary: true },
    { key: "status", header: "Status", cell: (r) => <Badge>{r.status}</Badge>, badge: true },
    { key: "owner", header: "Owner", cell: (r) => r.ownerName },
  ]}
  rows={risks}
  rowKey={(r) => r.id}
  onRowClick={(r) => inspector.open(<RiskDetail risk={r} />, r.title)}
  empty={<EmptyState purpose="..." />}
/>
```

Renders a table at `md`+, cards below `md` (chevron shown since `onRowClick` is set). Use `hideOnMobile` on a column that only makes sense as a table column (rare); use `renderCard` to fully override the card body.

Both consume `useBodyScrollLock`/`useInertShell`/`useReturnFocus` (`@/lib/hooks/use-sheet`) already — nothing to wire yourself. Build form controls with `<Input>`, `<Select>` and `<Textarea>` (they apply the `field` utility, the 44px phone floor and the solid `focus-ring`) inside a `<Field label error hint>`.

## Phone touch targets (44px) — what is already handled

- `<Button size="sm|md">` floors at 44px below `sm` with `max-sm:min-h-11` and keeps its compact desktop height. Do not add `h-11 sm:h-8` yourself; an `h-*` override changes the desktop height only.
- `<IconButton label>` is the icon-only button (44px below `lg`, 40px at `lg`+). `label` is required and becomes the `aria-label`.
- `<SegmentedControl>` segments are 44px tall below `sm`.
- A control that must stay visually small can carry a 44px hit area with a pseudo-element (`before:absolute before:-inset-3 before:content-['']`) instead of growing.

## Writing an overlay

An overlay that covers the page must render OUTSIDE `[data-app-shell]` (the shell is made `inert` below `lg` while one is open, so an overlay inside it would inert itself, and a `backdrop-filter` ancestor would re-anchor its `position: fixed`). From inside the shell, wrap it in `<Portal>` (`@/components/ui/portal`); then give it `role="dialog" aria-modal="true"` and a name, and call `useDialog({ open, onClose, containerRef, initialFocusRef, openerRef, sheet: true })` from `@/lib/hooks/use-sheet` for Escape (top-most only), the Tab trap, focus entry and return, scroll lock and shell inert.
