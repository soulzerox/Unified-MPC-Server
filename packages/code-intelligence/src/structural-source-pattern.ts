/**
 * The eight extensions a structural record can come from.
 *
 * Its own module so the query surface can recognise a source path without importing
 * the extractor, which loads `typescript`. Discovery and the specifier heuristic read
 * this pattern; the extractor's language table stays the extraction gate and must grow
 * with it.
 *
 * Case-insensitive because the extractor already lowercases the extension before the
 * language lookup: `FOO.TS` was admitted before this pattern existed and must stay so.
 */
export const STRUCTURAL_SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
