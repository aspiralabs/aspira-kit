---
date: 2026-09-19
tags: [tables, pagination, data-fetching]
applies-to: "@aspiralabs/ui"
---

# Table and picker pagination

`@aspiralabs/ui` has three components that page through data, and they expect two different response shapes. Pick the component from the data's size and shape; do not adapt one component's shape to another's endpoint.

## Which component

| Data | Component | Paging |
|---|---|---|
| Already in memory, small (hundreds of rows) | `DataTable` | Client-side. TanStack's pagination row model, 10 rows a page; Previous/Next render only when there is more than one page. |
| Server-side, open-ended (feeds, logs, anything that grows) | `DataInfiniteTable` | Cursor. TanStack Query `useInfiniteQuery`; an IntersectionObserver 100px above the end of the scroll viewport calls `fetchNextPage`. |
| Options for a select, filter, or picker | `InputSelect` / `StandardToolbar` filters (`dataMode="remote"`) | Offset. One debounced `GET` per search keystroke, `?limit=` and `?q=`, first page only. |

## The two response shapes

**Cursor** (`DataInfiniteTable`). The `queryFn` you pass is TanStack Query's options object; each page resolves to:

```ts
{ items: TData[]; nextCursor: string | null }
```

`getNextPageParam` reads `nextCursor`; `null` ends the list. Pages are flattened into one array for the table, so a row is only ever rendered once.

```tsx
<DataInfiniteTable
  columns={columns}
  queryFn={{
    queryKey: ['audit-log', filters],
    queryFn: ({ pageParam }) => fetchAuditLog({ cursor: pageParam, ...filters }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: 1,
  }}
  onRowClick="/audit/<id>"
/>
```

**Offset** (remote pickers). The endpoint returns `PaginatedResponse<T>` from `@aspiralabs/ui`:

```ts
{ data: T[]; pagination: { page; limit; totalCount; totalPages; hasNextPage; hasPreviousPage } }
```

Only `data` is read by the picker. `labelKey` (default `name`) and `valueKey` (default `id`) pick the label and value off each item; the whole item is passed to `entryRender` as `data`. When the search box is empty, `defaultParams` are sent instead of `q`, so the first page can be scoped (`{ status: 'active' }`) without a query.

## Rules

- A remote picker never gets a cursor endpoint and an infinite table never gets an offset endpoint. If the API only has one shape, the fix is an endpoint, not an adapter in the component.
- `DataTable` is client-side. If the row count depends on the user (their records, their team), it belongs in `DataInfiniteTable`.
- Row-click navigation on both tables is a URL template (`"/users/<id>"`) resolved against `row.original`. Pass `navigate={router.push}` in Next.js; the default is a full page load.
- Filter state for list pages lives in the URL. `useStandardPage` already does this for the `view` tab; toolbar filters should follow it (see `docs/patterns/standard-toolbar.mdx` through `get_pattern`).
