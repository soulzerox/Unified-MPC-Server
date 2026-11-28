/**
 * The eight extensions a structural record can come from.
 *
 * Its own module so the query surface can recognise a source path without importing
 * the extractor, which loads `typescript`. One pattern for discovery, the extractor's
 * language table and the specifier heuristic, so the three cannot disagree.
 */
export const STRUCTURAL_SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
