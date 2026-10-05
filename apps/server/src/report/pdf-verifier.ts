import { PDFDocument } from "pdf-lib";

const A4 = {
  short: 595.28,
  long: 841.89,
} as const;
const A4_TOLERANCE_POINTS = 0.15;

export interface Ucm25PdfVerification {
  pdf: string | null;
  bytes: number;
  pages: number;
  geometry: {
    standard: "A4";
    portraitPages: number;
    landscapePages: number;
    invalidPages: 0;
  };
  fonts: {
    family: "Carlito";
    embeddedFontPrograms: number;
    nonEmbeddedStandardFonts: string[];
    hasSubsettedCarlito: true;
  };
  title: string | null;
  subject: string | null;
}

export async function verifyUcm25CompatiblePdf(
  bytes: Uint8Array,
  displayPath?: string,
): Promise<Ucm25PdfVerification> {
  const rawPdf = Buffer.from(bytes).toString("latin1");
  const document = await PDFDocument.load(bytes, {
    updateMetadata: false,
  });
  if (document.getPageCount() < 1) {
    throw new Error("PDF has no pages");
  }

  const pageGeometry = document.getPages().map((page, index) => {
    const width = page.getWidth();
    const height = page.getHeight();
    const portrait =
      Math.abs(width - A4.short) <= A4_TOLERANCE_POINTS &&
      Math.abs(height - A4.long) <= A4_TOLERANCE_POINTS;
    const landscape =
      Math.abs(width - A4.long) <= A4_TOLERANCE_POINTS &&
      Math.abs(height - A4.short) <= A4_TOLERANCE_POINTS;
    return {
      page: index + 1,
      width,
      height,
      orientation: portrait
        ? ("portrait" as const)
        : landscape
          ? ("landscape" as const)
          : ("invalid" as const),
    };
  });
  const invalidPages = pageGeometry.filter(
    ({ orientation }) => orientation === "invalid",
  );
  if (invalidPages.length > 0) {
    throw new Error(
      `PDF contains ${invalidPages.length} non-A4 page(s): ${invalidPages
        .slice(0, 10)
        .map(({ page, width, height }) => `${page} (${width}x${height})`)
        .join(", ")}`,
    );
  }
  const portraitPages = pageGeometry.filter(
    ({ orientation }) => orientation === "portrait",
  ).length;
  const landscapePages = pageGeometry.length - portraitPages;
  if (portraitPages < 3 || landscapePages < 1) {
    throw new Error(
      "UCM25-compatible report must contain both portrait front matter and landscape costing pages",
    );
  }

  const nonEmbeddedStandardFonts = [
    ...new Set(
      [
        ...rawPdf.matchAll(
          /\/BaseFont\s*\/((?:Helvetica|Courier|Times)(?:-[A-Za-z]+)?)/g,
        ),
      ].map((match) => match[1]!),
    ),
  ];
  if (nonEmbeddedStandardFonts.length > 0) {
    throw new Error(
      `PDF uses non-embedded standard fonts: ${nonEmbeddedStandardFonts.join(", ")}`,
    );
  }
  const embeddedFontPrograms = [
    ...rawPdf.matchAll(/\/FontFile(?:2|3)?\s+\d+\s+\d+\s+R/g),
  ].length;
  const hasSubsettedCarlito =
    /\/BaseFont\s*\/[A-Z]{6}\+Carlito(?:-[A-Za-z]+)?/.test(rawPdf);
  if (embeddedFontPrograms < 1 || !hasSubsettedCarlito) {
    throw new Error(
      "UCM25-compatible report must embed a subsetted Carlito font program",
    );
  }

  return {
    pdf: displayPath ?? null,
    bytes: bytes.byteLength,
    pages: document.getPageCount(),
    geometry: {
      standard: "A4",
      portraitPages,
      landscapePages,
      invalidPages: 0,
    },
    fonts: {
      family: "Carlito",
      embeddedFontPrograms,
      nonEmbeddedStandardFonts: [],
      hasSubsettedCarlito: true,
    },
    title: document.getTitle() ?? null,
    subject: document.getSubject() ?? null,
  };
}
