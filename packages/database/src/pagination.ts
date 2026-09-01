// Supabase/PostgREST caps a single request at 1000 rows by default. A
// query with no .range()/.limit() that expects "all rows" (e.g. every
// agent message for a cost report) silently gets truncated once a table
// passes that size — worse, if it's ordered ascending, the truncation
// drops the MOST RECENT rows first, since only the oldest 1000 come back.
const DEFAULT_PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const page = await fetchPage(from, from + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
