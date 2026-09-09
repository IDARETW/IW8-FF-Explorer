// Sorting and searching a full extraction must never occupy the UI thread.
let records = [],
  sorted = new Map();
self.onmessage = ({ data }) => {
  if (data.reset) {
    records = [];
    sorted.clear();
    return;
  }
  if (data.records) {
    records = data.records.map((a) => ({
      ...a,
      search: `${a.path} ${a.displayName || ""}`.toLowerCase(),
    }));
    sorted.clear();
  }
  const { id, kind, pool, query, sort, page, pageSize } = data;
  if (!sorted.has(sort)) {
    const compare = new Intl.Collator().compare;
    sorted.set(
      sort,
      [...records].sort((a, b) =>
        sort === "size"
          ? b.size - a.size || compare(a.path, b.path)
          : sort === "type"
            ? compare(a.type, b.type) || compare(a.path, b.path)
            : compare(a.displayName || a.name, b.displayName || b.name),
      ),
    );
  }
  const matches = sorted
    .get(sort)
    .filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        (!pool || a.type === pool) &&
        (!query || a.search.includes(query)),
    );
  const current = Math.max(
    0,
    Math.min(page, Math.ceil(matches.length / pageSize) - 1),
  );
  self.postMessage({
    id,
    page: current,
    count: matches.length,
    paths: matches
      .slice(current * pageSize, (current + 1) * pageSize)
      .map((a) => a.path),
  });
};
