const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors, extractMatchId } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    let html;
    try {
      const response = await httpClient.get('/klub');
      html = response.data;
    } catch {
      const fallback = await httpClient.get('/klasemen');
      html = fallback.data;
    }

    const $ = cheerio.load(html);
    const clubs = [];
    const seen = new Set();

    $('.club-card, .team-card, .club-item, table tbody tr').each((i, el) => {
      const item = $(el);
      const name = cleanText(
        item.find('.club-name, .team-name, h3, h4, td:nth-child(2)').first().text()
      );

      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());

      const img = item.find('img').first();
      const logo = normalizeUrl(img.attr('data-src') || img.attr('src'));
      const link = item.find('a').attr('href');
      const slug = extractMatchId(link) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const stadium = cleanText(item.find('.stadium, .venue, .stadion').text()) || null;
      const city = cleanText(item.find('.city, .kota').text()) || null;

      clubs.push({
        id: slug,
        name,
        logo,
        stadium,
        city,
        profile_url: link ? normalizeUrl(link) : null
      });
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
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
