const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const targetPath = `/clubs/index/${COMPETITION}`;
    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data || '');

    if (debug === '1') {
      const clubLinks = [];
      $('a[href*="/clubs/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.includes('/clubs/index/')) {
          clubLinks.push({
            href,
            text: cleanText($(el).text()),
            img: $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || null
          });
        }
      });
      return res.status(200).json({
        success: true,
        targetPath,
        totalClubLinks: clubLinks.length,
        sample: clubLinks.slice(0, 20)
      });
    }

    const clubs = [];
    const seen = new Set();

    // Ambil dari seluruh tautan profil klub (/clubs/view/..., /clubs/detail/..., dll)
    $('a[href*="/clubs/"]').each((_, el) => {
      const item = $(el);
      if (item.closest('header, nav, footer').length > 0) return;

      const href = item.attr('href') || '';
      if (!href || href.includes('/clubs/index/')) return;

      const img = item.find('img').first();
      const rawName =
        cleanText(item.find('h1, h2, h3, h4, h5, span, p, div').first().text()) ||
        cleanText(item.text()) ||
        cleanText(img.attr('alt'));

      if (!rawName || rawName.length < 3 || seen.has(rawName.toLowerCase())) return;
      seen.add(rawName.toLowerCase());

      const logo = normalizeUrl(img.attr('data-src') || img.attr('src'));
      const slug = extractMatchId(href) || rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      clubs.push({
        id: slug,
        name: rawName,
        logo,
        profile_url: normalizeUrl(href)
      });
    });

    // Fallback dari halaman klasemen jika halaman klub memakai render dinamis
    if (clubs.length === 0) {
      const tableRes = await httpClient.get(`/table/index/${COMPETITION}`);
      const $t = cheerio.load(tableRes.data || '');
      $t('table tbody tr').each((_, row) => {
        const cols = $t(row).find('td');
        if (cols.length < 6) return;

        let name = '';
        cols.each((__, col) => {
          if (name) return;
          const txt = cleanText($t(col).text());
          if (txt && txt.length >= 3 && /[a-zA-Z]{3,}/.test(txt) && !/^[WDLMSK\s-]+$/i.test(txt)) {
            name = txt;
          }
        });

        if (!name || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());

        const img = $t(row).find('img').first();
        const link = $t(row).find('a[href]').first().attr('href');
        const slug = extractMatchId(link) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        clubs.push({
          id: slug,
          name,
          logo: normalizeUrl(img.attr('data-src') || img.attr('src')),
          profile_url: link ? normalizeUrl(link) : null
        });
      });
    }

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      updated_at: new Date().toISOString(),
      total: clubs.length,
      data: clubs
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil daftar klub dari ileague.id',
      error: error.message
    });
  }
};
