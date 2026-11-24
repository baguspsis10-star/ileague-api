const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const targetPath = `/table/index/${COMPETITION}`;

    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data || '');

    if (debug === '1') {
      const sampleRows = [];
      $('table tr').each((i, row) => {
        if (i >= 5) return;
        const cells = [];
        $(row)
          .find('th, td')
          .each((_, cell) => {
            cells.push({
              text: cleanText($(cell).text()),
              img: $(cell).find('img').attr('data-src') || $(cell).find('img').attr('src') || null
            });
          });
        sampleRows.push(cells);
      });
      return res.status(200).json({
        success: true,
        targetPath,
        totalTables: $('table').length,
        sampleRows
      });
    }

    const standings = [];

    $('table tbody tr').each((index, row) => {
      const cols = $(row).find('td');
      if (cols.length < 6) return;

      // Cari logo klub di dalam baris
      const imgEl = $(row)
        .find('img')
        .filter((_, img) => {
          const src = $(img).attr('data-src') || $(img).attr('src') || '';
          return src && !src.includes('flagcdn.com');
        })
        .first();
      const clubLogo = normalizeUrl(imgEl.attr('data-src') || imgEl.attr('src'));

      // Cari kolom yang berisi nama klub (teks huruf, bukan angka murni atau W/D/L)
      let clubName = '';
      let clubColIdx = -1;

      cols.each((colIdx, col) => {
        if (clubName) return;
        const txt = cleanText($(col).text());
        if (
          txt &&
          txt.length >= 3 &&
          /[a-zA-Z]{3,}/.test(txt) &&
          !/^[WDLMSK\s-]+$/i.test(txt)
        ) {
          clubName = txt;
          clubColIdx = colIdx;
        }
      });

      if (!clubName) return;

      // Ambil peringkat dari kolom pertama atau fallback ke urutan baris
      const rankText = cleanText($(cols[0]).text()).replace(/\D/g, '');
      const rank = rankText ? parseInt(rankText, 10) : index + 1;

      // Kumpulkan semua kolom angka setelah kolom nama klub
      const nums = [];
      cols.each((colIdx, col) => {
        if (colIdx <= clubColIdx) return;
        const raw = cleanText($(col).text());
        if (/^-?\d+$/.test(raw)) {
          nums.push(parseInt(raw, 10));
        }
      });

      // Urutan standar kolom klasemen: Main (P), Menang (W), Seri (D), Kalah (L), GM, GK, SG, Poin
      const played = nums[0] ?? 0;
      const win = nums[1] ?? 0;
      const draw = nums[2] ?? 0;
      const loss = nums[3] ?? 0;
      const goalsFor = nums.length >= 7 ? nums[4] : 0;
      const goalsAgainst = nums.length >= 7 ? nums[5] : 0;
      const goalDiff =
        nums.length >= 8
          ? nums[6]
          : nums.length >= 7
            ? goalsFor - goalsAgainst
            : nums[4] ?? 0;
      const points = nums.length > 0 ? nums[nums.length - 1] : 0;

      // Ambil form 5 pertandingan terakhir (jika tersedia)
      const form = [];
      $(row)
        .find('td:last-child span, td:last-child a, td:last-child div, .form-badge')
        .each((_, badge) => {
          const val = cleanText($(badge).text()).toUpperCase();
          if (['W', 'D', 'L', 'M', 'S', 'K'].includes(val)) {
            const map = { M: 'W', S: 'D', K: 'L' };
            form.push(map[val] || val);
          }
        });

      standings.push({
        rank,
        club: clubName,
        logo: clubLogo,
        played,
        win,
        draw,
        loss,
        goals_for: goalsFor,
        goals_against: goalsAgainst,
        goal_difference: goalDiff,
        points,
        form: form.slice(-5)
      });
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      updated_at: new Date().toISOString(),
      total: standings.length,
      data: standings
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil klasemen dari ileague.id',
      error: error.message
    });
  }
};
