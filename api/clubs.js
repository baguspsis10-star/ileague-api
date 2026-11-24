const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const response = await httpClient.get(`/clubs/index/${COMPETITION}`);
    const $ = cheerio.load(response.data || '');

    const clubMap = new Map();

    $('a[href*="/clubs/single/"]').each((_, el) => {
      const link = $(el);
      const href = link.attr('href') || '';
      const slug = extractMatchId(href);
      if (!slug) return;

      if (!clubMap.has(slug)) {
        clubMap.set(slug, {
          id: slug,
          name: slug.replace(/_+/g, ' ').trim(),
          logo: null,
          team_photo: null,
          profile_url: normalizeUrl(href)
        });
      }

      const entry = clubMap.get(slug);

      link.find('img').each((__, img) => {
        const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
        if (!src || src.includes('flagcdn.com')) return;

        if (src.includes('/uploads/images/logo/')) {
          entry.logo = src;
        } else if (src.includes('/uploads/images/club/')) {
          entry.team_photo = src;
        } else if (!entry.logo) {
          entry.logo = src;
        }
      });
    });

    const clubs = Array.from(clubMap.values());

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
