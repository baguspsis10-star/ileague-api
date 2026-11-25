const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function detectEventType(htmlLower, imgSrcLower, textLower = '') {
  const combined = `${htmlLower} ${imgSrcLower} ${textLower}`;
  if (combined.includes('own goal') || combined.includes('og') || combined.includes('bunuh diri')) {
    return 'OWN_GOAL';
  }
  if (combined.includes('pen') && (combined.includes('miss') || combined.includes('gagal'))) {
    return 'MISSED_PENALTY';
  }
  if (combined.includes('goal') || combined.includes('ball') || combined.includes('gol')) {
    return 'GOAL';
  }
  if (combined.includes('red') || combined.includes('merah') || combined.includes('rc')) {
    return 'RED_CARD';
  }
  if (combined.includes('yellow') || combined.includes('kuning') || combined.includes('yc')) {
    return 'YELLOW_CARD';
  }
  if (
    combined.includes('sub') ||
    combined.includes('exchange') ||
    combined.includes('in_out') ||
    combined.includes('ganti') ||
    combined.includes('arrow')
  ) {
    return 'SUBSTITUTION';
  }
  return 'EVENT';
}

function detectPositionHeader(textLower) {
  if (/^(penjaga\s*gawang|kiper|goalkeeper)s?$/i.test(textLower)) return 'GK';
  if (/^(belakang|bek|defender)s?$/i.test(textLower)) return 'DF';
  if (/^(gelandang|tengah|midfielder)s?$/i.test(textLower)) return 'MF';
  if (/^(penyerang|depan|forward|striker)s?$/i.test(textLower)) return 'FW';
  return null;
}

function isBenchHeader(textLower) {
  return /^(pemain\s*pengganti|cadangan|substitutes?|bench)$/i.test(textLower);
}

function isNoiseLineupText(textLower, homeNameLower, awayNameLower) {
  if (!textLower || textLower.length < 2) return true;
  if (textLower === 'vs' || textLower === 'v') return true;
  if (
    /^(line\s*-?\s*up|starting\s*xi|pemain\s*inti|pelatih|head\s*coach|coach|manager|official)$/i.test(
      textLower
    )
  ) {
    return true;
  }
  if (homeNameLower && textLower === homeNameLower) return true;
  if (awayNameLower && textLower === awayNameLower) return true;
  return false;
}

function cleanPlayerNameAndNumber(rawText) {
  let text = cleanText(rawText);
  if (!text) return null;

  // Ekstrak nomor punggung di awal (contoh: "14 '90TEJA PAKU ALAM" atau "#14 TEJA")
  let number = '';
  const numMatch = text.match(/^#?(\d{1,2})\b\s*(.*)$/);
  if (numMatch) {
    number = numMatch[1];
    text = numMatch[2];
  }

  // Hapus menit pergantian yang menempel (contoh: "'90", "'76", "'62", "'90+2", "90'")
  text = text
    .replace(/'\d{1,3}(?:\+\d+)?\s*/g, ' ')
    .replace(/\b\d{1,3}(?:\+\d+)?'\s*/g, ' ')
    .replace(/\s*\([A-Z]{2,3}\)\s*$/g, '')
    .trim();

  // Jika nomor punggung ada di akhir (contoh: "MARC KLOK 23")
  if (!number) {
    const tailNum = text.match(/^(.+?)\s+#?(\d{1,2})$/);
    if (tailNum) {
      text = tailNum[1].trim();
      number = tailNum[2];
    }
  }

  text = cleanText(text);
  if (!text || text.length < 2 || /^\d+$/.test(text)) return null;

  return {
    number,
    name: text
  };
}

function parseLineupsFromDom($, homeName, awayName) {
  const home = { formation: '', starting: [], substitutes: [] };
  const away = { formation: '', starting: [], substitutes: [] };

  const lineupRoot = $('#lineup, #matchlineup, .match-lineup, [id*="lineup"]').first();
  if (!lineupRoot.length) return null;

  const rootText = cleanText(lineupRoot.text());
  const formations = rootText.match(/\b(\d-\d-\d(?:-\d)?)\b/g) || [];
  if (formations[0]) home.formation = formations[0];
  if (formations[1]) away.formation = formations[1];

  const homeLower = homeName.toLowerCase();
  const awayLower = awayName.toLowerCase();

  // Kumpulkan token teks secara berurutan dari elemen daun (leaf nodes)
  const tokens = [];
  lineupRoot.find('li, tr, p, h3, h4, h5, span, div, td').each((_, el) => {
    const node = $(el);
    // Abaikan kontainer besar yang punya banyak anak
    if (node.find('li, tr, p, h3, h4, h5, div, td').length > 0) return;
    const txt = cleanText(node.text());
    if (!txt || txt.length > 95) return;
    if (tokens[tokens.length - 1] !== txt) {
      tokens.push(txt);
    }
  });

  // Gabungkan token nomor punggung yang terpisah elemen dengan nama pemain (misal ["14", "'90", "TEJA PAKU ALAM"])
  const mergedTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i];
    const next = tokens[i + 1] || '';
    const next2 = tokens[i + 2] || '';

    if (/^#?\d{1,2}$/.test(cur) && /^'\d{1,3}(?:\+\d+)?$/.test(next) && next2 && !detectPositionHeader(next2.toLowerCase())) {
      mergedTokens.push(`${cur} ${next} ${next2}`);
      i += 2;
    } else if (/^#?\d{1,2}$/.test(cur) && next && !detectPositionHeader(next.toLowerCase()) && !isBenchHeader(next.toLowerCase()) && next.toLowerCase() !== 'vs') {
      mergedTokens.push(`${cur} ${next}`);
      i += 1;
    } else if (/^'\d{1,3}(?:\+\d+)?$/.test(cur) && next && !detectPositionHeader(next.toLowerCase())) {
      mergedTokens.push(`${cur} ${next}`);
      i += 1;
    } else {
      mergedTokens.push(cur);
    }
  }

  let currentSide = 'home';
  let currentPos = 'MF';
  let isBench = false;
  let gkHeaderCount = 0;

  for (const token of mergedTokens) {
    const lower = token.toLowerCase();

    // Deteksi perpindahan dari tim Home ke tim Away
    if (lower === 'vs' || (awayLower && lower.includes(awayLower) && home.starting.length > 0)) {
      currentSide = 'away';
      currentPos = 'GK';
      isBench = false;
      continue;
    }

    const posHeader = detectPositionHeader(lower);
    if (posHeader) {
      if (posHeader === 'GK') {
        gkHeaderCount += 1;
        if (gkHeaderCount >= 2 && currentSide === 'home') {
          currentSide = 'away';
        }
      }
      currentPos = posHeader;
      isBench = false;
      continue;
    }

    if (isBenchHeader(lower)) {
      isBench = true;
      continue;
    }

    if (isNoiseLineupText(lower, homeLower, awayLower)) continue;

    const parsed = cleanPlayerNameAndNumber(token);
    if (!parsed) continue;

    const target = currentSide === 'home' ? home : away;
    const alreadyExists = [...target.starting, ...target.substitutes].some(
      (p) => p.name.toLowerCase() === parsed.name.toLowerCase()
    );
    if (alreadyExists) continue;

    const playerObj = {
      number: parsed.number,
      name: parsed.name,
      position: currentPos
    };

    if (!isBench && target.starting.length < 11) {
      target.starting.push(playerObj);
    } else {
      target.substitutes.push(playerObj);
    }
  }

  if (home.starting.length === 0 && away.starting.length === 0) return null;
  return { home, away };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message: 'Parameter "id" atau "url" wajib diisi.'
    });
  }

  try {
    let targetPath = '';
    if (url) {
      targetPath = url.split('#')[0];
    } else {
      const cleanId = String(id).replace(/^\/+|\/+$/g, '');
      targetPath = cleanId.startsWith('result/detail/')
        ? `/${cleanId}`
        : cleanId.startsWith(`${COMPETITION}/`)
        ? `/result/detail/${cleanId}`
        : `/result/detail/${COMPETITION}/${cleanId}`;
    }

    const response = await httpClient.get(targetPath, {
      headers: { Referer: 'https://ileague.id/fixtures' }
    });

    const html = response.data || '';
    const $ = cheerio.load(html);

    const urlParts = targetPath.replace(/\/$/, '').split('/');
    const awaySlug = urlParts[urlParts.length - 1] || 'Away';
    const homeSlug = urlParts[urlParts.length - 2] || 'Home';
    const dateFromUrl = urlParts[urlParts.length - 3] || null;

    const homeName = homeSlug.replace(/_+/g, ' ').trim();
    const awayName = awaySlug.replace(/_+/g, ' ').trim();

    // 1. Logo klub
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
    $('.score, .match-score, .scoreboard h1, .scoreboard h2, .scoreboard h3, .result-score').each((_, el) => {
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
        new RegExp(
          `${homeSlug.replace(/_+/g, '\\s+')}.*?\\b(\\d{1,2})\\s*[-:]\\s*(\d{1,2})\\b.*?${awaySlug.replace(/_+/g, '\\s+')}`,
          'i'
        )
      );
      if (fallbackScore) {
        homeScore = parseInt(fallbackScore[1], 10);
        awayScore = parseInt(fallbackScore[2], 10);
      }
    }

    // 3. Info Pertandingan (Stadion, Kick-off, Wasit, Penonton)
    let venue = '';
    let referee = '';
    let kickoff = '';
    let attendance = '';

    $('li, tr, p, div, span').each((_, el) => {
      if ($(el).children().length > 3) return;
      const text = cleanText($(el).text());
      if (!text || text.length > 110) return;

      // Kick-off: dukung format 19:00 atau 19.00
      if (!kickoff) {
        const timeMatch = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*(WIB|WITA|WIT))?\b/i);
        if (timeMatch && !text.includes('90+')) {
          kickoff = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]} ${(timeMatch[3] || 'WIB').toUpperCase()}`;
        }
      }

      // Stadion: wajib mengandung kata stadion/gelora/arena dan bukan tanggal
      if (
        !venue &&
        /(stadion|stadium|gelora|arena)/i.test(text) &&
        !/^(senin|selasa|rabu|kamis|jumat|sabtu|minggu)/i.test(text)
      ) {
        const cleaned = text.replace(/^(stadion|stadium|venue)\s*:?\s*/i, '').trim();
        if (cleaned.length >= 5 && cleaned.length <= 80) venue = cleaned;
      }

      // Wasit
      if (!referee && /(wasit|referee)/i.test(text)) {
        const cleaned = text.replace(/^(wasit|referee)\s*:?\s*/i, '').trim();
        if (cleaned.length >= 3 && cleaned.length <= 65) referee = cleaned;
      }

      // Penonton: wajib >= 3 digit agar tidak mengambil jam 19 dari 19:00
      if (!attendance && /(penonton|attendance)/i.test(text)) {
        const attMatch = text.match(/\b(\d{1,3}(?:[.,]\d{3})+|\d{3,6})\b/);
        if (attMatch) attendance = attMatch[1];
      }
    });

    // 4. Statistik Pertandingan
    const statistics = [];
    $('#matchstats li, #stats li, .match-stats li').each((_, el) => {
      const li = $(el);
      const homeVal = cleanText(li.find('.left').first().text());
      const label = cleanText(li.find('.center').first().text());
      const awayVal = cleanText(li.find('.right').first().text());

      if (label && homeVal !== '' && awayVal !== '') {
        if (!statistics.some((s) => s.label === label)) {
          statistics.push({ label, home: homeVal, away: awayVal });
        }
      }
    });

    // 5. Susunan Pemain
    const lineups = parseLineupsFromDom($, homeName, awayName);

    // 6. Linimasa / Kejadian Pertandingan
    const events = [];
    const seenEvents = new Set();
    const homePlayerNames = lineups
      ? [...lineups.home.starting, ...lineups.home.substitutes].map((p) => p.name.toLowerCase())
      : [];
    const awayPlayerNames = lineups
      ? [...lineups.away.starting, ...lineups.away.substitutes].map((p) => p.name.toLowerCase())
      : [];

    const eventContainers = $('#matchtimeline, #live_timeline, #summary, .match-timeline, [id*="timeline"]');
    const eventRows = eventContainers.length
      ? eventContainers.find('li, tr, .timeline-item, .event-item, .row')
      : $('li, tr');

    eventRows.each((_, el) => {
      const row = $(el);
      // Hindari baris lineup yang punya nomor punggung + nama
      if (row.closest('#lineup, #matchlineup, [id*="lineup"]').length > 0) return;

      const fullText = cleanText(row.text());
      if (!fullText || fullText.length > 200) return;

      // Wajib ada format menit dengan tanda petik ('42 atau 42' atau '90+5)
      const minMatch = fullText.match(/(?:'(\d{1,3}(?:\+\d+)?)|(\d{1,3}(?:\+\d+)?)')/);
      if (!minMatch) return;

      const minuteNum = minMatch[1] || minMatch[2];
      const minute = `${minuteNum}'`;

      const leftText = cleanText(row.find('.left, td:first-child').first().text());
      const rightText = cleanText(row.find('.right, td:last-child').first().text());

      let detail = '';
      let sideHint = '';

      if (leftText && !leftText.includes(minuteNum) && (!rightText || rightText.includes(minuteNum))) {
        sideHint = 'home';
        detail = leftText;
      } else if (rightText && !rightText.includes(minuteNum) && (!leftText || leftText.includes(minuteNum))) {
        sideHint = 'away';
        detail = rightText;
      } else {
        detail = cleanText(fullText.replace(new RegExp(`'?${minuteNum.replace('+', '\\+')}'?`, 'g'), ''));
      }

      detail = cleanText(detail.replace(/^[-–•:]+\s*|\s*[-–•:]+$/g, ''));
      if (!detail || detail.length < 2) return;

      // Cocokkan nama pemain dengan roster Home/Away jika tersedia
      const detailLower = detail.toLowerCase();
      let team = sideHint || 'home';
      if (awayPlayerNames.some((n) => n && (detailLower.includes(n) || n.includes(detailLower)))) {
        team = 'away';
      } else if (homePlayerNames.some((n) => n && (detailLower.includes(n) || n.includes(detailLower)))) {
        team = 'home';
      }

      const imgSrcs = row
        .find('img, i, svg')
        .map((__, icon) => `${$(icon).attr('src') || ''} ${$(icon).attr('alt') || ''} ${$(icon).attr('class') || ''}`)
        .get()
        .join(' ')
        .toLowerCase();

      const type = detectEventType((row.html() || '').toLowerCase(), imgSrcs, fullText.toLowerCase());
      const eventKey = `${minute}-${team}-${type}-${detail}`;

      if (!seenEvents.has(eventKey)) {
        seenEvents.add(eventKey);
        events.push({ minute, team, type, player: detail });
      }
    });

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      updated_at: new Date().toISOString(),
      data: {
        id: id || null,
        date: dateFromUrl,
        kickoff: kickoff || null,
        venue: venue || null,
        referee: referee || null,
        attendance: attendance || null,
        home: {
          name: homeName,
          logo: clubLogos[0] || null,
          score: homeScore
        },
        away: {
          name: awayName,
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
