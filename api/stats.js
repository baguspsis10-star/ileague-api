const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const baseStatsPath = `/top_actions/player/index/${COMPETITION}`;
    const response = await httpClient.get(baseStatsPath);
    const finalUrl = response.request?.res?.responseUrl || baseStatsPath;
    const html = response.data || '';
    const $ = cheerio.load(html);

    if (debug === '1') {
      const allLinks = [];
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = cleanText($(el).text());
        if (
          href &&
          !href.includes('/news/') &&
          !href.includes('/photo/') &&
          !href.includes('/video/') &&
          !href.includes('/press/') &&
          allLinks.length < 40
        ) {
          allLinks.push({ text, href });
        }
      });

      const images = [];
      $('img').each((_, el) => {
        const src = $(el).attr('data-src') || $(el).attr('src') || '';
        if (src && !src.includes('flagcdn.com') && images.length < 25) {
          images.push(src);
        }
      });

      return res.status(200).json({
        success: true,
        requestedPath: baseStatsPath,
        finalUrl,
        title: cleanText($('title').text()),
        allLinks,
        images
      });
    }

    // Jika endpoint langsung memiliki data pemain di masa mendatang
    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      final_url: finalUrl,
      updated_at: new Date().toISOString(),
      data: {
        top_scorers: [],
        top_assists: []
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
