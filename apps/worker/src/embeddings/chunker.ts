interface Chunk {
  content: string;
  metadata: {
    chunk_index: number;
    start_char: number;
    end_char: number;
  };
}

const CHUNK_SIZE = 1000; // characters
const CHUNK_OVERLAP = 200;

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];

  if (text.length <= CHUNK_SIZE) {
    return [
      {
        content: text.trim(),
        metadata: { chunk_index: 0, start_char: 0, end_char: text.length },
      },
    ];
  }

  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    // Try to break at a paragraph or sentence boundary
    if (end < text.length) {
      const breakPoints = ["\n\n", "\n", ". ", "! ", "? "];
      for (const bp of breakPoints) {
        const lastBreak = text.lastIndexOf(bp, end);
        if (lastBreak > start + CHUNK_SIZE / 2) {
          end = lastBreak + bp.length;
          break;
        }
      }
    } else {
      end = text.length;
    }

    const content = text.slice(start, end).trim();
    if (content.length > 0) {
      chunks.push({
        content,
        metadata: { chunk_index: chunkIndex, start_char: start, end_char: end },
      });
      chunkIndex++;
    }

    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }

  return chunks;
}
