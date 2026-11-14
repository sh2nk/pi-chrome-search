/**
 * Tokenization shared by claim selection and research query refinement.
 *
 * Pure and deterministic: no clock, no network, no model. Function words are
 * removed from query terms in both English and Russian because a search query
 * written in either language still carries the same shape.
 */

const WORD = /[\p{L}\p{N}]+/gu;

/** Function words that carry no topical signal in an EN/RU search query. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could", "did",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "me", "my", "of", "on", "or", "our", "should", "so", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "to",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
  "а", "без", "бы", "был", "была", "были", "быть", "в", "во", "вот", "все", "всё",
  "вы", "где", "да", "для", "до", "его", "ее", "её", "если", "есть", "же", "за",
  "и", "из", "или", "им", "их", "к", "как", "ко", "когда", "кто", "ли", "мне",
  "может", "мы", "на", "над", "не", "него", "нее", "неё", "нет", "ни", "но", "о",
  "об", "он", "она", "они", "оно", "от", "по", "под", "при", "про", "с", "со",
  "так", "там", "то", "только", "у", "уже", "чего", "чем", "что", "чтобы", "это",
  "я",
]);

/** Lowercase Unicode word/number tokens. Punctuation never becomes a term. */
export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const normalized = text.normalize("NFKC").toLowerCase();
  return normalized.match(WORD) ?? [];
}

/** Query terms: deduplicated tokens with function words removed, in first-seen order. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}
