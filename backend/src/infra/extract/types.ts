export interface ExtractedPage {
  page: number;
  text: string;
}

export interface ExtractionResult {
  pages: ExtractedPage[];
  pageCount: number;
  engine: string;
}
