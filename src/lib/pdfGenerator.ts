import { jsPDF } from 'jspdf';
import { RegisteredStudent } from './attendance';
import { AttendanceCheckIn } from './attendance';

// ── Type augmentation for jsPDF ──
declare module 'jspdf' {
  interface jsPDF {
    autoTable: (options: {
      head: string[][];
      body: string[][];
      styles?: Record<string, unknown>;
      headStyles?: Record<string, unknown>;
      bodyStyles?: Record<string, unknown>;
      alternateRowStyles?: Record<string, unknown>;
      columnStyles?: Record<string, Record<string, unknown>>;
      margin?: { top?: number; left?: number; right?: number };
      tableWidth?: string;
      didDrawPage?: (data: { pageCount: number; cursor: { y: number } }) => void;
      willDrawCell?: (data: {
        section: 'head' | 'body' | 'foot';
        row: { index: number };
        column: { index: number };
      }) => void;
    }) => jsPDF;
  }
}

// ── Registry PDF options ──
interface PDFGeneratorOptions {
  title: string;
  subtitle: string;
  totalStudents: number;
  filterInfo: string;
  students: RegisteredStudent[];
  generatedAt: string;
}

// ── Check-in PDF options ──
interface CheckInPDFOptions {
  title: string;
  subtitle: string;
  totalCount: number;
  courseTitle: string;
  courseCode?: string;
  lecturerName?: string;
  lectureDate?: string;
  checkIns: AttendanceCheckIn[];
  generatedAt: string;
}

// ── Layout constants ──
const MARGIN = 15;
const ROW_HEIGHT = 8;
const HEADER_ROW_HEIGHT = 9;
const TABLE_TOP = 70;

// ── Helper: draw a single table row ──
function drawTableRow(
  doc: jsPDF,
  startX: number,
  y: number,
  columns: string[],
  widths: number[],
  isAlternate: boolean,
  boldIndices: number[] = []
): void {
  if (isAlternate) {
    doc.setFillColor(245 / 255, 247 / 255, 250 / 255);
    doc.rect(startX, y, widths.reduce((a, b) => a + b, 0), ROW_HEIGHT, 'F');
  }

  doc.setTextColor(50, 50, 50);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  let x = startX;
  for (let col = 0; col < columns.length; col++) {
    if (boldIndices.includes(col)) {
      doc.setFont('helvetica', 'bold');
    }

    const align = col === 0 || col >= columns.length - 1 ? 'center' : 'left';
    doc.text(columns[col], x + 1, y + ROW_HEIGHT / 2 + 2.5, {
      align: align as 'center' | 'left',
      maxWidth: widths[col] - 2,
    });

    if (boldIndices.includes(col)) {
      doc.setFont('helvetica', 'normal');
    }
    x += widths[col];
  }
}

// ── Helper: draw table header ──
function drawTableHeader(doc: jsPDF, startX: number, startY: number, headers: string[], widths: number[]): number {
  doc.setFillColor(37, 51, 81);
  doc.rect(startX, startY, widths.reduce((a, b) => a + b, 0), HEADER_ROW_HEIGHT, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);

  let x = startX;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], x + 1, startY + HEADER_ROW_HEIGHT / 2 + 3, {
      align: (i === 0 ? 'center' : 'left') as 'center' | 'left',
      maxWidth: widths[i] - 2,
    });
    x += widths[i];
  }

  return startY + HEADER_ROW_HEIGHT;
}

// ── Helper: add footers to all pages ──
function addFooters(doc: jsPDF, totalPages: number, pageWidth: number, pageHeight: number, label: string): void {
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setTextColor(150, 150, 150);
    doc.setFontSize(8);
    const footerY = pageHeight - 12;
    doc.text(
      `${label} — Page ${p} of ${totalPages}`,
      pageWidth / 2,
      footerY,
      { align: 'center' as const }
    );
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, footerY + 3, pageWidth - MARGIN, footerY + 3);
  }
}

// ── Draw a complete table with pagination ──
function drawPaginatedTable(
  doc: jsPDF,
  startX: number,
  headers: string[],
  widths: number[],
  rows: string[][],
  pageHeight: number
): number {
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const maxRowsPerPage = Math.floor((pageHeight - TABLE_TOP - 18) / ROW_HEIGHT);
  const totalPages = Math.max(1, Math.ceil(rows.length / maxRowsPerPage));

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();

    const pageStart = page * maxRowsPerPage;
    const pageEnd = Math.min(pageStart + maxRowsPerPage, rows.length);

    let y = TABLE_TOP;
    const rowsOnPage = pageEnd - pageStart;
    const tableHeight = HEADER_ROW_HEIGHT + rowsOnPage * ROW_HEIGHT;

    // Table border
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.5);
    doc.rect(startX, y, tableWidth, tableHeight);

    // Header
    y = drawTableHeader(doc, startX, y, headers, widths);

    for (let i = pageStart; i < pageEnd; i++) {
      drawTableRow(doc, startX, y, rows[i], widths, i % 2 !== 0);
      y += ROW_HEIGHT;
    }
  }

  return totalPages;
}

// ── REGISTRY PDF ──

export function generateStudentRegistryPDF(options: PDFGeneratorOptions): void {
  const { title, subtitle, totalStudents, filterInfo, students, generatedAt } = options;

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ── Header background ──
  doc.setFillColor(25, 37, 69);
  doc.rect(0, 0, pageWidth, 45, 'F');

  // ── Title ──
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(title, MARGIN, 22);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(180, 200, 230);
  doc.text(subtitle, MARGIN, 34);

  // ── Filter info badge ──
  const filterText = `${filterInfo} · ${totalStudents} student${totalStudents !== 1 ? 's' : ''}`;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const filterWidth = doc.getTextWidth(filterText);
  const badgeX = pageWidth - MARGIN - filterWidth - 12;
  const badgeY = 14;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(255, 255, 255);
  doc.roundedRect(badgeX, badgeY, filterWidth + 12, 14, 3, 3, 'FD');
  doc.setTextColor(25, 37, 69);
  doc.text(filterText, badgeX + 6, badgeY + 9);

  // ── Date ──
  doc.setTextColor(180, 200, 230);
  doc.setFontSize(9);
  doc.text(`Generated: ${generatedAt}`, MARGIN, 42);

  // ── Summary bar ──
  doc.setFillColor(237 / 255, 242 / 255, 251 / 255);
  doc.rect(0, 52, pageWidth, 14, 'F');

  doc.setTextColor(45, 65, 100);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`Total Registered Students: ${totalStudents}`, MARGIN, 60);

  // ── Table columns: S/N, Full Name, Reg Number, Faculty, Department, Level, Registered ──
  const headers = ['S/N', 'Full Name', 'Reg Number', 'Faculty', 'Department', 'Level', 'Registered'];
  const widths = [12, 44, 36, 36, 36, 20, 30];
  const centerTableWidth = widths.reduce((a, b) => a + b, 0);
  const startX = (pageWidth - centerTableWidth) / 2;

  const rows = students.map((s, i) => [
    String(i + 1),
    s.name,
    s.regNumber,
    s.faculty,
    s.department,
    s.level,
    new Date(s.registeredAt).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
  ]);

  const totalPages = drawPaginatedTable(doc, startX, headers, widths, rows, pageHeight);

  // ── Footers ──
  addFooters(doc, totalPages, pageWidth, pageHeight, 'UniAttend Student Registry');

  // ── Save ──
  const fileName = `UniAttend_Registry_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(fileName);
}

// ── CHECK-IN PDF ──

export function generateCheckInPDF(options: CheckInPDFOptions): void {
  const { title, subtitle, totalCount, courseTitle, courseCode, lecturerName, lectureDate, checkIns, generatedAt } = options;

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  // ── Header background ──
  doc.setFillColor(37, 51, 81);
  doc.rect(0, 0, pageWidth, 45, 'F');

  // ── Title ──
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(title, MARGIN, 22);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(180, 200, 230);
  doc.text(subtitle, MARGIN, 34);

  // ── Badge ──
  const badgeText = `${courseTitle} · ${totalCount} student${totalCount !== 1 ? 's' : ''}`;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const badgeWidth = doc.getTextWidth(badgeText);
  const badgeX = pageWidth - MARGIN - badgeWidth - 12;
  const badgeY = 14;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(255, 255, 255);
  doc.roundedRect(badgeX, badgeY, badgeWidth + 12, 14, 3, 3, 'FD');
  doc.setTextColor(37, 51, 81);
  doc.text(badgeText, badgeX + 6, badgeY + 9);

  // ── Date ──
  doc.setTextColor(180, 200, 230);
  doc.setFontSize(9);
  doc.text(`Generated: ${generatedAt}`, MARGIN, 42);

  // ── Summary bar ──
  doc.setFillColor(237 / 255, 242 / 255, 251 / 255);
  doc.rect(0, 52, pageWidth, 14, 'F');

  doc.setTextColor(45, 65, 100);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  const summaryParts = [
    `Total Checked In: ${totalCount}`,
    courseCode ? `Course Code: ${courseCode}` : '',
    lecturerName ? `Lecturer: ${lecturerName}` : '',
    lectureDate ? `Lecture: ${lectureDate}` : '',
  ].filter(Boolean);
  doc.text(summaryParts.join('   |   '), MARGIN, 60);

  // ── Table columns: S/N, Full Name, Reg Number, Faculty, Dept, Level, Checked In ──
  const headers = ['S/N', 'Full Name', 'Reg Number', 'Faculty', 'Department', 'Level', 'Checked In'];
  const widths = [12, 40, 36, 36, 32, 20, 42];
  const centerTableWidth = widths.reduce((a, b) => a + b, 0);
  const startX = (pageWidth - centerTableWidth) / 2;

  const rows = checkIns.map((c, i) => [
    String(i + 1),
    c.name,
    c.regNumber,
    c.faculty,
    c.department,
    c.level || '—',
    new Date(c.checkedInAt).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  ]);

  const totalPages = drawPaginatedTable(doc, startX, headers, widths, rows, pageHeight);

  // ── Footers ──
  addFooters(doc, totalPages, pageWidth, pageHeight, `UniAttend — ${courseTitle}`);

  // ── Save ──
  const fileName = `UniAttend_${courseTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(fileName);
}
