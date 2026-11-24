const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url, debug } = req.query;
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

    if (debug === '1') {
      const tabIds = [];
      $('.tab-pane, [id]').each((_, el) => {
        const elId = $(el).attr('id');
        if (elId && /stat|lineup|event|summary|timeline|match|goal|card|susunan|ringkasan/i.test(elId)) {
          tabIds.push(elId);
        }
      });

      return res.status(200).json({
        success: true,
        targetPath,
        tabIds,
        statsHtmlSample: ($('#stats').html() || '').slice(0, 2500),
        bodySample: cleanText($('body').text()).slice(0, 1200)
      });
    }

    const urlParts = targetPath.replace(/\/$/, '').split('/');
    const awaySlug = urlParts[urlParts.length - 1] || 'Away';
    const homeSlug = urlParts[urlParts.length - 2] || 'Home';
    const dateFromUrl = urlParts[urlParts.length - 3] || null;

    // 1. Ambil logo klub (hindari header/nav/footer & competition-logo)
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

    // 2. Ambil skor pertandingan dari header scoreboard
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
        new RegExp(`${homeSlug.replace(/_+/g, '\\s+')}.*?\\b(\\d{1,2})\\s*[-:]\\s*(\\d{1,2})\\b.*?${awaySlug.replace(/_+/g, '\\s+')}`, 'i')
      );
      if (fallbackScore) {
        homeScore = parseInt(fallbackScore[1], 10);
        awayScore = parseInt(fallbackScore[2], 10);
      }
    }

    // 3. Parse Statistik dari kontainer #stats
    const statistics = [];
    const statsContainer = $('#stats').length ? $('#stats') : $('body');
    statsContainer.find('tr, .stat-row, .stats-row, .progress-item, .row').each((_, el) => {
      const row = $(el);
      if (row.find('tr, .stat-row').length > 1) return;

      const cols = row.find('td');
      if (cols.length === 3) {
        const homeVal = cleanText($(cols[0]).text());
        const label = cleanText($(cols[1]).text());
        const awayVal = cleanText($(cols[2]).text());
        if (label && /\d/.test(homeVal) && /\d/.test(awayVal)) {
          statistics.push({ label, home: homeVal, away: awayVal });
        }
        return;
      }

      const leafTexts = [];
      row.find('span, p, div, strong, b').each((__, node) => {
        if ($(node).children().length === 0) {
          const t = cleanText($(node).text());
          if (t) leafTexts.push(t);
        }
      });

      if (leafTexts.length === 3 && /\d/.test(leafTexts[0]) && /\d/.test(leafTexts[2]) && /[a-zA-Z]{3,}/.test(leafTexts[1])) {
        if (!statistics.some((s) => s.label === leafTexts[1])) {
          statistics.push({ label: leafTexts[1], home: leafTexts[0], away: leafTexts[2] });
        }
      }
    });

    // 4. Parse Kejadian Pertandingan (Gol, Kartu, Pergantian)
    const events = [];
    $('tr, li, .event-item, .timeline-item, .row').each((_, el) => {
      const row = $(el);
      if (row.closest('header, nav, footer, #stats').length > 0) return;
      if (row.find('tr, li').length > 1) return;

      const text = cleanText(row.text());
      if (text.length > 160) return;

      const minMatch = text.match(/\b(\d{1,3}(?:\+\d+)?')\b/);
      if (!minMatch) return;

      const htmlLower = (row.html() || '').toLowerCase();
      let type = 'EVENT';
      if (htmlLower.includes('goal') || htmlLower.includes('ball') || htmlLower.includes('gol')) type = 'GOAL';
      else if (htmlLower.includes('yellow') || htmlLower.includes('kuning')) type = 'YELLOW_CARD';
      else if (htmlLower.includes('red') || htmlLower.includes('merah')) type = 'RED_CARD';
      else if (htmlLower.includes('sub') || htmlLower.includes('exchange') || htmlLower.includes('ganti')) type = 'SUBSTITUTION';

      events.push({
        minute: minMatch[1],
        type,
        detail: text
      });
    });

    // 5. Parse Susunan Pemain (Lineup) jika tab #lineup tersedia
    const lineups = [];
    $('#lineup, [id*="lineup" i], [id*="susunan" i]').find('tr, li, .player-item').each((_, el) => {
      const text = cleanText($(el).text());
      if (text && text.length >= 3 && text.length <= 80 && !lineups.includes(text)) {
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
