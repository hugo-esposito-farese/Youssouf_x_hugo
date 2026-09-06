const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Voir docs/photos-et-sorties.md pour le détail des 2 feuilles reproduites ici.

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const JOURS_ABBR_FR = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function pdfFileName(year, month) {
  return `feuille-vehicule-${monthKey(year, month)}.pdf`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDateList(year, month) {
  const total = daysInMonth(year, month);
  const dates = [];
  for (let d = 1; d <= total; d += 1) {
    dates.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return dates;
}

function dateLabelShort(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function dateLabelActivite(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${JOURS_ABBR_FR[dow]}. ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

function fmtKm(value) {
  return value === null || value === undefined ? '' : Number(value).toFixed(1);
}

function fmt(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

// Un jour "clos" pour la feuille véhicule = un event 'debut' ET un event 'fin' ce jour-là
// (cf. CLAUDE_youssouf.md). On prend le PREMIER 'debut' et le DERNIER 'fin' chronologiques du
// jour (une journée peut avoir plusieurs shifts, cf. docs/photos-et-sorties.md).
async function getDonneesVehiculeParJour(pool, year, month) {
  const debut = new Date(Date.UTC(year, month - 1, 1));
  const fin = new Date(Date.UTC(year, month, 1));
  const { rows } = await pool.query(
    `
    WITH first_debut AS (
      SELECT DISTINCT ON (event_date)
        event_date, km AS km_depart, jauge AS jauge_depart, conducteur
      FROM events
      WHERE type = 'debut' AND event_date >= $1 AND event_date < $2
      ORDER BY event_date, heure NULLS LAST, created_at
    ),
    last_fin AS (
      SELECT DISTINCT ON (event_date)
        event_date, km AS km_arrivee, jauge AS jauge_arrivee
      FROM events
      WHERE type = 'fin' AND event_date >= $1 AND event_date < $2
      ORDER BY event_date, heure DESC NULLS LAST, created_at DESC
    )
    SELECT fd.event_date, fd.km_depart, lf.km_arrivee, fd.jauge_depart, lf.jauge_arrivee, fd.conducteur
    FROM first_debut fd
    JOIN last_fin lf ON lf.event_date = fd.event_date;
    `,
    [debut, fin],
  );
  const map = new Map();
  for (const row of rows) map.set(row.event_date, row);
  return map;
}

// Feuille activité : TOUS les events du mois (pas seulement les jours clos), placés dans la
// tranche horaire (0h-8h / 8h-16h / 16h-24h) correspondant à l'heure lue sur la photo.
async function getEvenementsActiviteParJour(pool, year, month) {
  const debut = new Date(Date.UTC(year, month - 1, 1));
  const fin = new Date(Date.UTC(year, month, 1));
  const { rows } = await pool.query(
    `SELECT event_date, type, heure, created_at
     FROM events
     WHERE event_date >= $1 AND event_date < $2
     ORDER BY event_date, heure NULLS LAST, created_at`,
    [debut, fin],
  );
  const map = new Map();
  for (const row of rows) {
    const heureAffichee = row.heure || null;
    let heureNum;
    if (heureAffichee && /^\d{1,2}:\d{2}/.test(heureAffichee)) {
      heureNum = parseInt(heureAffichee.slice(0, 2), 10);
    } else {
      // Repli si l'heure n'a pas pu être lue sur la photo : heure d'upload côté serveur.
      heureNum = new Date(row.created_at).getHours();
    }
    const bande = heureNum < 8 ? 'bande0' : heureNum < 16 ? 'bande1' : 'bande2';
    const label = `${row.type === 'debut' ? 'Début' : 'Fin'} ${heureAffichee || '?'}`;
    if (!map.has(row.event_date)) {
      map.set(row.event_date, { bande0: [], bande1: [], bande2: [] });
    }
    map.get(row.event_date)[bande].push(label);
  }
  return map;
}

function drawGauge(doc, x, y, width, value) {
  const lineY = y + 6;
  doc.lineWidth(0.75).strokeColor('#999999');
  doc.moveTo(x, lineY).lineTo(x + width, lineY).stroke();
  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    const tx = x + width * f;
    doc.moveTo(tx, lineY - 2).lineTo(tx, lineY + 2).stroke();
  });
  if (typeof value === 'number') {
    const mx = x + (width * Math.min(Math.max(value, 0), 100)) / 100;
    doc.lineWidth(1.5).strokeColor('#111111');
    doc.moveTo(mx, lineY - 5).lineTo(mx, lineY + 1).stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#111111')
      .text(`${value}%`, x, lineY + 3, { width, align: 'center' });
  }
  doc.strokeColor('#000000').fillColor('#000000');
}

function pageBreakIfNeeded(doc, y, rowHeight, redrawHeader) {
  if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    return redrawHeader();
  }
  return y;
}

function drawHeaderRow(doc, y, headers, colWidths, startX, tableWidth, rowHeight) {
  doc.rect(startX, y, tableWidth, rowHeight).fill('#eeeeee');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
  let x = startX;
  headers.forEach((text, i) => {
    doc.text(text, x + 3, y + rowHeight / 2 - 4, { width: colWidths[i] - 6 });
    x += colWidths[i];
  });
  return y + rowHeight;
}

function drawFeuilleVehicule(doc, { dates, donneesParJour, driverName, truckPlate, year, month }) {
  doc.font('Helvetica-Bold').fontSize(16)
    .text(`Feuille véhicule — ${MOIS_FR[month - 1]} ${year}`, { align: 'center' });
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#555555')
    .text(`Immatriculation : ${truckPlate}  —  Conducteur : ${driverName}`, { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(0.6);

  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [
    tableWidth * 0.11, // Date
    tableWidth * 0.13, // km départ
    tableWidth * 0.13, // km arrivée
    tableWidth * 0.18, // jauge départ
    tableWidth * 0.18, // jauge arrivée
    tableWidth * 0.13, // litrage pris
    tableWidth * 0.14, // conducteur
  ];
  const headers = ['Date', 'Km départ', 'Km arrivée', 'Jauge départ', 'Jauge arrivée', 'Litrage pris', 'Conducteur'];
  const headerRowHeight = 16;
  const rowHeight = 19;

  const redrawHeader = () => drawHeaderRow(doc, doc.page.margins.top, headers, colWidths, startX, tableWidth, headerRowHeight);

  let y = drawHeaderRow(doc, doc.y, headers, colWidths, startX, tableWidth, headerRowHeight);

  for (const dateStr of dates) {
    y = pageBreakIfNeeded(doc, y, rowHeight, redrawHeader);

    const jour = donneesParJour.get(dateStr);
    let x = startX;

    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    doc.text(dateLabelShort(dateStr), x + 3, y + rowHeight / 2 - 4, { width: colWidths[0] - 6 });
    x += colWidths[0];

    doc.text(jour ? fmtKm(jour.km_depart) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[1] - 6 });
    x += colWidths[1];
    doc.text(jour ? fmtKm(jour.km_arrivee) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[2] - 6 });
    x += colWidths[2];

    drawGauge(doc, x + 4, y + 1, colWidths[3] - 8, jour ? jour.jauge_depart : null);
    x += colWidths[3];
    drawGauge(doc, x + 4, y + 1, colWidths[4] - 8, jour ? jour.jauge_arrivee : null);
    x += colWidths[4];

    // Litrage pris : jamais disponible depuis la photo du compteur, colonne volontairement vide.
    x += colWidths[5];

    doc.font('Helvetica').fontSize(9);
    doc.text(jour ? fmt(jour.conducteur) : '', x + 3, y + rowHeight / 2 - 4, { width: colWidths[6] - 6 });

    y += rowHeight;
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor('#dddddd').stroke();
    doc.strokeColor('#000000');
  }
}

function drawFeuilleActivite(doc, { dates, evenementsParJour, year, month }) {
  doc.font('Helvetica-Bold').fontSize(16)
    .text(`Feuille activité — ${MOIS_FR[month - 1]} ${year}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9).fillColor('#555555')
    .text('Destination / repas / découché : non renseignés (hors périmètre).', { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(1);

  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [
    tableWidth * 0.12, // Date
    tableWidth * 0.16, // 0h-8h
    tableWidth * 0.16, // 8h-16h
    tableWidth * 0.16, // 16h-24h
    tableWidth * 0.11, // destination
    tableWidth * 0.09, // p. déjeuner
    tableWidth * 0.10, // repas midi
    tableWidth * 0.10, // repas soir
  ];
  const headers = ['Date', 'de 0h à 8h', 'de 8h à 16h', 'de 16h à 24h', 'Destination', 'P. déj.', 'Repas midi', 'Repas soir'];
  const headerRowHeight = 24;
  const lineHeight = 10;
  const minRowHeight = 20;

  const redrawHeader = () => drawHeaderRow(doc, doc.page.margins.top, headers, colWidths, startX, tableWidth, headerRowHeight);

  let y = drawHeaderRow(doc, doc.y, headers, colWidths, startX, tableWidth, headerRowHeight);

  for (const dateStr of dates) {
    const evt = evenementsParJour.get(dateStr) || { bande0: [], bande1: [], bande2: [] };
    const maxLignes = Math.max(1, evt.bande0.length, evt.bande1.length, evt.bande2.length);
    const rowHeight = Math.max(minRowHeight, 8 + maxLignes * lineHeight);

    y = pageBreakIfNeeded(doc, y, rowHeight, redrawHeader);

    let x = startX;
    doc.font('Helvetica').fontSize(8).fillColor('#000000');
    doc.text(dateLabelActivite(dateStr), x + 3, y + 6, { width: colWidths[0] - 6 });
    x += colWidths[0];

    [evt.bande0, evt.bande1, evt.bande2].forEach((lignes) => {
      doc.text(lignes.join('\n'), x + 3, y + 6, { width: colWidths[1] - 6 });
      x += colWidths[1];
    });

    // destination / repas : colonnes hors périmètre, volontairement vides.

    y += rowHeight;
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor('#dddddd').stroke();
    doc.strokeColor('#000000');
  }
}

async function regenerateMonthPdf({ pool, storageDir, year, month, driverName, truckPlate }) {
  const dates = buildDateList(year, month);
  const [donneesParJour, evenementsParJour] = await Promise.all([
    getDonneesVehiculeParJour(pool, year, month),
    getEvenementsActiviteParJour(pool, year, month),
  ]);

  fs.mkdirSync(storageDir, { recursive: true });
  const filePath = path.join(storageDir, pdfFileName(year, month));

  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  drawFeuilleVehicule(doc, { dates, donneesParJour, driverName, truckPlate, year, month });
  doc.addPage();
  drawFeuilleActivite(doc, { dates, evenementsParJour, year, month });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { fileName: pdfFileName(year, month), filePath };
}

module.exports = { regenerateMonthPdf, pdfFileName, monthKey };
