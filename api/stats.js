const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function parseRankingList($, sectionSelector, logoToClubMap) {
  const players = [];
  const section = $(sectionSelector).first();
  if (!section.length) return players;

  section.find('ul li').each((index, el) => {
    const li = $(el);
    const link = li.find('a[href*="/singleplayer/"]').first();
    if (!link.length) return;

    const shortName = cleanText(link.text());
    const href = link.attr('href') || '';
    const fullSlug = extractMatchId(href);
    const fullName = fullSlug
      ? fullSlug
          .replace(/_+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      : shortName;

    const rankText = cleanText(li.find('.position').first().text()).replace(/\D/g, '');
    const rank = rankText ? parseInt(rankText, 10) : index + 1;

    const pointsText = cleanText(li.find('.points').first().text()).replace(/\D/g, '');
    const total = pointsText ? parseInt(pointsText, 10) : 0;

    // Foto pemain (tersedia pada peringkat 1 / .single-player)
    const playerImg = li.find('img[src*="/uploads/images/player/"]').first();
    const photo = playerImg.length
      ? normalizeUrl(playerImg.attr('data-src') || playerImg.attr('src'))
      : null;

    // Logo klub di dalam tautan pemain
    const clubImg = link.find('img').first().length
      ? link.find('img').first()
      : li.find('img[src*="/uploads/images/logo/"]').first();
    const clubLogo = clubImg.length
      ? normalizeUrl(clubImg.attr('data-src') || clubImg.attr('src'))
      : null;

    const clubName = (clubLogo && logoToClubMap.get(clubLogo)) || '';

    players.push({
      rank,
      player: shortName || fullName,
      full_name: fullName,
      photo,
      club: clubName,
      club_logo: clubLogo,
      total,
      profile_url: normalizeUrl(href)
    });
  });

  return players;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    // Ambil halaman utama (#goals & #assists) dan klasemen (untuk mapping nama klub) secara paralel
    const [homeRes, tableRes] = await Promise.all([
      httpClient.get('/'),
      httpClient.get(`/table/index/${COMPETITION}`).catch(() => ({ data: '' }))
    ]);

    const logoToClubMap = new Map();
    if (tableRes && tableRes.data) {
      const $t = cheerio.load(tableRes.data);
      $t('table tbody tr').each((_, row) => {
        const img = $t(row).find('img[src*="/uploads/images/logo/"]').first();
        const logoUrl = normalizeUrl(img.attr('data-src') || img.attr('src'));
        if (!logoUrl) return;

        let clubName = '';
        $t(row)
          .find('td')
          .each((__, col) => {
            if (clubName) return;
            const txt = cleanText($t(col).text());
            if (txt && txt.length >= 3 && /[a-zA-Z]{3,}/.test(txt) && !/^[WDLMSK\s-]+$/i.test(txt)) {
              clubName = txt;
            }
          });

        if (clubName) {
          logoToClubMap.set(logoUrl, clubName);
        }
      });
    }

    const $ = cheerio.load(homeRes.data || '');
    const topScorers = parseRankingList($, '#goals', logoToClubMap);
    const topAssists = parseRankingList($, '#assists', logoToClubMap);

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
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
