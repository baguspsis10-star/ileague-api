const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { debug } = req.query;
    const targetPath = `/top_actions/player/index/${COMPETITION}`;
    const response = await httpClient.get(targetPath);
    const html = response.data || '';
    const $ = cheerio.load(html);

    // Kumpulkan semua script inline untuk mencari endpoint AJAX statistik pemain
    const scripts = [];
    $('script:not([src])').each((_, el) => {
      const code = $(el).html() || '';
      if (code.includes('top_actions') || code.includes('ajax') || code.includes('fetch') || code.includes('player')) {
        scripts.push(cleanText(code).slice(0, 1200));
      }
    });

    // Kumpulkan opsi dropdown kategori statistik jika ada
    const selectOptions = [];
    $('select option').each((_, el) => {
      selectOptions.push({
        value: $(el).attr('value') || '',
        text: cleanText($(el).text())
      });
    });

    // Kumpulkan link spesifik ke profil pemain
    const playerItems = [];
    $('a[href*="/player/"], a[href*="/players/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = cleanText($(el).text());
      if (text && !href.includes('/top_actions/')) {
        playerItems.push({ href, text });
      }
    });

    if (debug === '1') {
      return res.status(200).json({
        success: true,
        targetPath,
        selectOptions,
        playerItemsSample: playerItems.slice(0, 15),
        scriptsSample: scripts.slice(0, 5)
      });
    }

    // Parsing kartu/baris pemain jika dirender langsung di HTML
    const topScorers = [];
    const topAssists = [];

    $('a[href*="/player/"], a[href*="/players/"]').each((_, el) => {
      const card = $(el).closest('tr, .card, .item, li, div');
      const name = cleanText($(el).text());
      if (!name || name.length < 3) return;

      const imgs = card.find('img').filter((__, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src') || '';
        return src && !src.includes('flagcdn.com');
      });

      let photo = null;
      let clubLogo = null;
      imgs.each((__, img) => {
        const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
        if (!src) return;
        if (src.includes('/uploads/images/logo/')) clubLogo = src;
        else if (!photo) photo = src;
      });

      const fullText = cleanText(card.text());
      const numMatch = fullText.match(/\b(\d{1,2})\b/g);
      const total = numMatch ? parseInt(numMatch[numMatch.length - 1], 10) : 0;

      if (!topScorers.some((p) => p.player === name)) {
        topScorers.push({
          rank: topScorers.length + 1,
          player: name,
          photo,
          club: '',
          club_logo: clubLogo,
          total
        });
      }
    });

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
