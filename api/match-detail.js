const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function detectEventType(htmlLower, imgSrcLower) {
  const combined = `${htmlLower} ${imgSrcLower}`;
  if (combined.includes('goal') || combined.includes('ball') || combined.includes('gol')) {
    return 'GOAL';
  }
  if (combined.includes('yellow') || combined.includes('kuning') || combined.includes('yc')) {
    return 'YELLOW_CARD';
  }
  if (combined.includes('red') || combined.includes('merah') || combined.includes('rc')) {
    return 'RED_CARD';
  }
  if (combined.includes('sub') || combined.includes('exchange') || combined.includes('in_out') || combined.includes('ganti')) {
    return 'SUBSTITUTION';
  }
  return 'EVENT';
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message: 'Parameter "id" atau "url" wajib diisi. Contoh: /api/match-detail?id=2026-11-20/GARUDAYAKSA_FC/MADURA_UNITED_FC'
    });
  }

  try {
    const targetPath = url ? url.split('#')[0] : `/result/detail/${COMPETITION}/${id}`;
    const response = await httpClient.get(targetPath, {
      headers: { Referer: 'https://ileague.id/fixtures' }
    });

    const html = response.data || '';
    const $ = cheerio.load(html);

    const urlParts = targetPath.replace(/\/$/, '').split('/');
    const awaySlug = urlParts[urlParts.length - 1] || 'Away';
    const homeSlug = urlParts[urlParts.length - 2] || 'Home';
    const dateFromUrl = urlParts[urlParts.length - 3] || null;

    // 1. Logo klub (abaikan header, nav, footer & competition-logo)
    const clubLogos = [];
    $('img').each((_, img) => {
      if ($(img).closest('header, nav, footer').length > 0) return;
      const src = normalizeUrl($(img).attr('data-src') || $(img).attr('src'));
      if (
        src &&
        src.includes('/uploads/images/logo/') &&
        !src.includes('competition-logo') &&
        !clubLogos.includes(src)
      ) {
        clubLogos.push(src);
      }
    });

    // 2. Skor pertandingan
    let homeScore = null;
    let awayScore = null;
    const scoreCandidates = $('.score, .match-score, .scoreboard h1, .scoreboard h2, .scoreboard h3, .result-score');
    scoreCandidates.each((_, el) => {
      if (homeScore !== null) return;
      const m = cleanText($(el).text()).match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
      if (m) {
        homeScore = parseInt(m[1], 10);
        awayScore = parseInt(m[2], 10);
      }
    });

    if (homeScore === null) {
      const bodyText = cleanText($('body').text());
      const fallbackScore = bodyText.match(
        new RegExp(`${homeSlug.replace(/_+/g, '\\s+')}.*?\\b(\\d{1,2})\\s*[-:]\\s*(\d{1,2})\\b.*?${awaySlug.replace(/_+/g, '\\s+')}`, 'i')
      );
      if (fallbackScore) {
        homeScore = parseInt(fallbackScore[1], 10);
        awayScore = parseInt(fallbackScore[2], 10);
      }
    }

    // 3. Statistik Pertandingan dari #matchstats li (span.left, span.center, span.right)
    const statistics = [];
    $('#matchstats li, #stats li').each((_, el) => {
      const li = $(el);
      const homeVal = cleanText(li.find('.left').first().text());
      const label = cleanText(li.find('.center').first().text());
      const awayVal = cleanText(li.find('.right').first().text());

      if (label && homeVal !== '' && awayVal !== '') {
        if (!statistics.some((s) => s.label === label)) {
          statistics.push({
            label,
            home: homeVal,
            away: awayVal
          });
        }
      }
    });

    // 4. Kejadian Pertandingan dari #matchtimeline, #live_timeline, dan #summary
    const events = [];
    const seenEvents = new Set();

    $('#matchtimeline li, #live_timeline li, #summary li, #matchtimeline tr, #summary tr').each((_, el) => {
      const row = $(el);
      const fullText = cleanText(row.text());
      if (!fullText || fullText.length > 180) return;

      // Mendukung format menit '45 atau 45' (termasuk tambahan waktu '90+2)
      const minMatch = fullText.match(/(?:'(\d{1,3}(?:\+\d+)?)|(\d{1,3}(?:\+\d+)?)')/);
      if (!minMatch) return;

      const minuteNum = minMatch[1] || minMatch[2];
      const minute = `${minuteNum}'`;

      const leftText = cleanText(row.find('.left, td:first-child').first().text());
      const rightText = cleanText(row.find('.right, td:last-child').first().text());

      let team = null;
      let detail = fullText;
      if (leftText && !rightText) {
        team = 'home';
        detail = leftText;
      } else if (rightText && !leftText) {
        team = 'away';
        detail = rightText;
      } else if (leftText && rightText) {
        // Jika salah satu sisi berisi menit dan sisi lain berisi nama pemain
        if (leftText.includes(minuteNum)) {
          team = 'away';
          detail = rightText;
        } else {
          team = 'home';
          detail = leftText;
        }
      }

      const imgSrcs = row
        .find('img')
        .map((__, img) => $(img).attr('src') || $(img).attr('alt') || '')
        .get()
        .join(' ')
        .toLowerCase();

      const type = detectEventType((row.html() || '').toLowerCase(), imgSrcs);
      const cleanDetail = cleanText(detail.replace(/'?\d{1,3}(?:\+\d+)?'?/g, '')) || fullText;
      const eventKey = `${minute}-${team}-${cleanDetail}`;

      if (!seenEvents.has(eventKey)) {
        seenEvents.add(eventKey);
        events.push({
          minute,
          team,
          type,
          player: cleanDetail
        });
      }
    });

    // 5. Susunan Pemain (#lineup)
    const lineups = [];
    $('#lineup li, #lineup tr').each((_, el) => {
      const text = cleanText($(el).text());
      if (text && text.length >= 3 && text.length <= 90 && !lineups.includes(text)) {
        lineups.push(text);
      }
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      updated_at: new Date().toISOString(),
      data: {
        id: id || null,
        date: dateFromUrl,
        home: {
          name: homeSlug.replace(/_+/g, ' ').trim(),
          logo: clubLogos[0] || null,
          score: homeScore
        },
        away: {
          name: awaySlug.replace(/_+/g, ' ').trim(),
          logo: clubLogos[1] || null,
          score: awayScore
        },
        events,
        statistics,
        lineups
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil detail pertandingan dari ileague.id',
      error: error.message
    });
  }
};
