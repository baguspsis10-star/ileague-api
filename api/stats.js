const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function extractPlayersFromContainer($, container) {
  const list = [];
  $(container)
    .find('tr, .player-item, .stat-item, .card, li')
    .each((_, el) => {
      const row = $(el);
      if (row.find('th').length > 0) return;

      const imgs = row.find('img').filter((__, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src') || '';
        return src && !src.includes('flagcdn.com');
      });

      const texts = [];
      row.find('td, span, p, div, h4, h5, strong, a').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (t && !/^\d+$/.test(t) && /[a-zA-Z]{2,}/.test(t) && !texts.includes(t)) {
            texts.push(t);
          }
        }
      });

      const player = texts[0] || '';
      const club = texts[1] || '';
      if (!player || /^(pemain|player|nama|klub|club)$/i.test(player)) return;

      const nums = [];
      row.find('td, span, p, div, strong').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (/^\d{1,3}$/.test(t)) nums.push(parseInt(t, 10));
        }
      });

      const total = nums.length > 0 ? nums[nums.length - 1] : 0;
      if (total === 0 && nums.length === 0) return;

      let photo = null;
      let clubLogo = null;

      imgs.each((__, img) => {
        const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
        if (!src) return;
        if (src.includes('/uploads/images/logo/')) {
          clubLogo = src;
        } else if (!photo) {
          photo = src;
        }
      });

      if (!clubLogo && imgs.length === 1) {
        clubLogo = photo;
        photo = null;
      }

      list.push({
        rank: list.length + 1,
        player,
        photo,
        club,
        club_logo: clubLogo,
        total
      });
    });

  return list;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const targetPath = `/top_actions/player/index/${COMPETITION}`;
    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data || '');

    if (debug === '1') {
      const headings = [];
      $('h1, h2, h3, h4, h5, .card-header, .nav-tabs a, .title').each((_, el) => {
        const t = cleanText($(el).text());
        if (t && headings.length < 30) headings.push(t);
      });

      return res.status(200).json({
        success: true,
        targetPath,
        totalTables: $('table').length,
        headings,
        bodySnippet: cleanText($('main, .content, body').first().text()).slice(0, 1200)
      });
    }

    let topScorers = [];
    let topAssists = [];

    // 1. Cek berdasarkan section/panel/tab berjudul Goal & Assist
    $('.card, .panel, section, .tab-pane, .box, .col-md-6, .col-lg-6').each((_, box) => {
      const title = cleanText($(box).find('h2, h3, h4, h5, .card-header, .box-title, .title').first().text()).toUpperCase();
      if ((title.includes('GOAL') || title.includes('GOL') || title.includes('SCORER')) && topScorers.length === 0) {
        topScorers = extractPlayersFromContainer($, box);
      } else if (title.includes('ASSIST') && topAssists.length === 0) {
        topAssists = extractPlayersFromContainer($, box);
      }
    });

    // 2. Fallback berdasarkan urutan tabel jika judul section tidak terdeteksi
    if (topScorers.length === 0 && topAssists.length === 0) {
      const tables = $('table');
      if (tables.length >= 1) topScorers = extractPlayersFromContainer($, tables[0]);
      if (tables.length >= 2) topAssists = extractPlayersFromContainer($, tables[1]);
    }

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      path_used: targetPath,
      updated_at: new Date().toISOString(),
      data: {
        top_scorers: topScorers,
        top_assists: topAssists
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil statistik pemain dari ileague.id',
      error: error.message
    });
  }
};
