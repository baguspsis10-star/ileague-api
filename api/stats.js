const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function parsePlayers($) {
  const players = [];
  const seen = new Set();

  $('table tbody tr, .player-card, .card, .item, li').each((_, el) => {
    const row = $(el);
    if (row.closest('header, nav, footer').length > 0) return;

    // Cari link profil pemain atau teks nama pemain
    const playerLink = row.find('a[href*="/player"], a[href*="/players"]').first();
    const imgs = row.find('img').filter((__, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      return src && !src.includes('flagcdn.com') && !src.includes('competition-logo');
    });

    if (!playerLink.length && imgs.length === 0) return;

    const texts = [];
    row.find('td, span, p, div, h4, h5, strong, a').each((__, node) => {
      if ($(node).children().length === 0) {
        const t = cleanText($(node).text());
        if (t && !/^\d+$/.test(t) && /[a-zA-Z]{3,}/.test(t) && !texts.includes(t)) {
          texts.push(t);
        }
      }
    });

    const name = cleanText(playerLink.text()) || texts[0] || '';
    if (!name || name.length < 3 || seen.has(name.toLowerCase())) return;
    if (/^(beranda|jadwal|klasemen|klub|stats|aksi top|login|register)/i.test(name)) return;

    const club = texts.find((t) => t !== name) || '';

    const nums = [];
    row.find('td, span, p, div, strong').each((__, node) => {
      if ($(node).children().length === 0) {
        const t = cleanText($(node).text());
        if (/^\d{1,2}$/.test(t)) nums.push(parseInt(t, 10));
      }
    });

    const total = nums.length > 0 ? nums[nums.length - 1] : 0;
    if (total === 0) return;

    seen.add(name.toLowerCase());

    let photo = null;
    let clubLogo = null;
    imgs.each((__, img) => {
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (!src) return;
      if (src.includes('/uploads/images/logo/')) clubLogo = src;
      else if (!photo) photo = src;
    });

    players.push({
      rank: players.length + 1,
      player: name,
      photo,
      club,
      club_logo: clubLogo,
      total
    });
  });

  return players;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const landingPath = `/top_actions/player/${COMPETITION}`;

    // 1. Ambil cookie sesi dari halaman induk statistik
    const landingRes = await httpClient.get(landingPath);
    const rawCookies = landingRes.headers['set-cookie'] || [];
    const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');

    const candidatePaths = [
      `/top_actions/player/index/${COMPETITION}`,
      `/top_actions/player/index/${COMPETITION}/GOAL`,
      `/top_actions/player/index/${COMPETITION}/GOALS`,
      `/top_actions/club/index/${COMPETITION}`
    ];

    const probeResults = [];
    let bestHtml = '';
    let usedPath = '';

    for (const path of candidatePaths) {
      try {
        const resp = await httpClient.get(path, {
          headers: {
            Referer: `https://ileague.id${landingPath}`,
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          }
        });
        const finalUrl = resp.request?.res?.responseUrl || path;
        const redirectedHome = finalUrl === 'https://ileague.id/' || finalUrl === 'https://ileague.id';
        probeResults.push({ path, finalUrl, redirectedHome, length: (resp.data || '').length });

        if (!redirectedHome && !bestHtml) {
          bestHtml = resp.data || '';
          usedPath = path;
        }
      } catch (err) {
        probeResults.push({ path, error: err.message });
      }
    }

    if (debug === '1') {
      const $dbg = cheerio.load(bestHtml || landingRes.data || '');
      return res.status(200).json({
        success: true,
        cookieCaptured: Boolean(cookieHeader),
        probeResults,
        usedPath: usedPath || landingPath,
        snippet: cleanText($dbg('main, .content, body').first().text()).slice(0, 900)
      });
    }

    const $ = cheerio.load(bestHtml || '');
    const topScorers = bestHtml ? parsePlayers($) : [];

    // Coba ambil Top Assist jika kategori ASSIST tersedia
    let topAssists = [];
    try {
      const assistRes = await httpClient.get(`/top_actions/player/index/${COMPETITION}/ASSIST`, {
        headers: {
          Referer: `https://ileague.id${landingPath}`,
          ...(cookieHeader ? { Cookie: cookieHeader } : {})
        }
      });
      const assistFinalUrl = assistRes.request?.res?.responseUrl || '';
      if (assistFinalUrl !== 'https://ileague.id/' && assistFinalUrl !== 'https://ileague.id') {
        topAssists = parsePlayers(cheerio.load(assistRes.data || ''));
      }
    } catch (_) {}

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      path_used: usedPath || null,
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
