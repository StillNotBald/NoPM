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

Both consume `useBodyScrollLock`/`useInertShell`/`useReturnFocus` (`@/lib/hooks/use-sheet`) already — nothing to wire yourself. Apply the `field` utility class to any `<select>`/`<textarea>` you build directly (not through `Input`).
