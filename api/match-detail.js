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

function parsePlayerRow($, el) {
  const node = $(el);
  const fullText = cleanText(node.text());
  if (!fullText || fullText.length < 2 || fullText.length > 100) return null;

  const lower = fullText.toLowerCase();
  if (
    lower.includes('starting') ||
    lower.includes('substitut') ||
    lower.includes('cadangan') ||
    lower.includes('pemain inti') ||
    lower.includes('pengganti') ||
    lower.includes('lineup') ||
    lower.includes('line-up') ||
    lower.includes('coach') ||
    lower.includes('pelatih')
  ) {
    return null;
  }

  let number = cleanText(
    node.find('.number, .no, .jersey, td:first-child, span:first-child').first().text()
  );
  let name = cleanText(
    node.find('.name, .player-name, .player, a, td:nth-child(2)').first().text()
  );
  let position = cleanText(
    node.find('.pos, .position, td:nth-child(3)').first().text()
  );

  // Fallback jika nomor dan nama menyatu dalam satu teks (misal: "14 Teja Paku Alam (GK)")
  if (!/^\d{1,2}$/.test(number) || !name || name === number) {
    const match = fullText.match(/^#?(\d{1,2})\s+(.+?)(?:\s*\(([A-Z]{2,3})\))?$/);
    if (match) {
      number = match[1];
      name = cleanText(match[2]);
      position = position || match[3] || '';
    } else {
      const tailNum = fullText.match(/^(.+?)\s+#?(\d{1,2})$/);
      if (tailNum) {
        name = cleanText(tailNum[1]);
        number = tailNum[2];
      } else {
        number = '';
        name = fullText.replace(/\s*\([A-Z]{2,3}\)\s*$/, '').trim();
      }
    }
  }

  name = cleanText(name.replace(/^#?\d{1,2}\s+/, ''));
  if (!name || name.length < 2) return null;

  return {
    number: number || '',
    name,
    position: position || ''
  };
}

function extractSideLineup($, container) {
  const starting = [];
  const substitutes = [];
  let formation = '';

  const containerText = cleanText(container.text());
  const formMatch = containerText.match(/\b(\d-\d-\d(?:-\d)?)\b/);
  if (formMatch) formation = formMatch[1];

  let isBenchSection = false;
  const rows = container.find('tr, li, .player-row, .lineup-player');

  if (rows.length > 0) {
    rows.each((_, el) => {
      const rowText = cleanText($(el).text()).toLowerCase();
      if (
        rowText.includes('substitut') ||
        rowText.includes('cadangan') ||
        rowText.includes('pengganti') ||
        rowText.includes('bench')
      ) {
        isBenchSection = true;
        return;
      }
      if (
        rowText.includes('starting') ||
        rowText.includes('pemain inti') ||
        rowText.includes('line up') ||
        rowText.includes('line-up')
      ) {
        isBenchSection = false;
        return;
      }

      const player = parsePlayerRow($, el);
      if (!player) return;

      const exists = [...starting, ...substitutes].some(
        (p) => p.name.toLowerCase() === player.name.toLowerCase()
      );
      if (exists) return;

      if (!isBenchSection && starting.length < 11) {
        starting.push(player);
      } else {
        substitutes.push(player);
      }
    });
  }

  return { formation, starting, substitutes };
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  const { id, url } = req.query;
  if (!id && !url) {
    return res.status(400).json({
      success: false,
      message:
        'Parameter "id" atau "url" wajib diisi. Contoh: /api/match-detail?id=2026-11-22/PERSIB_BANDUNG/BALI_UNITED_FC'
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
    const scoreCandidates = $(
      '.score, .match-score, .scoreboard h1, .scoreboard h2, .scoreboard h3, .result-score'
    );
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

    // 3. Info Pertandingan (Stadion, Wasit, Kick-off, Penonton)
    let venue = '';
    let referee = '';
    let kickoff = '';
    let attendance = '';

    $('li, tr, p, div, span').each((_, el) => {
      if ($(el).children().length > 4) return;
      const text = cleanText($(el).text());
      if (!text || text.length > 140) return;

      if (!venue && /(stadion|stadium|gelora|arena|venue)/i.test(text)) {
        const cleaned = text.replace(/^(stadion|stadium|venue)\s*:?\s*/i, '').trim();
        if (cleaned.length >= 4 && cleaned.length <= 90) venue = cleaned;
      }
      if (!referee && /(wasit|referee)/i.test(text)) {
        const cleaned = text.replace(/^(wasit|referee)\s*:?\s*/i, '').trim();
        if (cleaned.length >= 3 && cleaned.length <= 70) referee = cleaned;
      }
      if (!attendance && /(penonton|attendance)/i.test(text)) {
        const numMatch = text.match(/[\d.,]{2,}/);
        if (numMatch) attendance = numMatch[0];
      }
      if (!kickoff && /\b([01]?\d|2[0-3]):[0-5]\d\b/.test(text) && text.length <= 45) {
        const timeMatch = text.match(/\b([01]?\d|2[0-3]):[0-5]\d(?:\s*WIB|\s*WITA|\s*WIT)?/i);
        if (timeMatch) kickoff = timeMatch[0].toUpperCase();
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
          statistics.push({
            label,
            home: homeVal,
            away: awayVal
          });
        }
      }
    });

    // 5. Kejadian Pertandingan / Linimasa
    const events = [];
    const seenEvents = new Set();

    const timelineSelectors = [
      '#matchtimeline li',
      '#live_timeline li',
      '#summary li',
      '.match-timeline li',
      '.timeline li',
      '#matchtimeline tr',
      '#live_timeline tr',
      '#summary tr',
      '.timeline tr',
      '[id*="timeline"] li',
      '[id*="timeline"] tr'
    ].join(', ');

    $(timelineSelectors).each((_, el) => {
      const row = $(el);
      const fullText = cleanText(row.text());
      if (!fullText || fullText.length > 220) return;

      // Cari menit baik di .center, .minute, .time, maupun di teks baris (42', '42, 90+5')
      const centerText = cleanText(row.find('.center, .minute, .time').first().text());
      const minSource = centerText || fullText;
      const minMatch = minSource.match(/(?:'(\d{1,3}(?:\+\d+)?)|(\d{1,3}(?:\+\d+)?)'?)/);
      if (!minMatch) return;

      const minuteNum = minMatch[1] || minMatch[2];
      const minute = `${minuteNum}'`;

      const leftText = cleanText(row.find('.left, td:first-child').first().text());
      const rightText = cleanText(row.find('.right, td:last-child').first().text());

      let team = null;
      let detail = '';

      if (leftText && !leftText.includes(minuteNum) && (!rightText || rightText.includes(minuteNum))) {
        team = 'home';
        detail = leftText;
      } else if (rightText && !rightText.includes(minuteNum) && (!leftText || leftText.includes(minuteNum))) {
        team = 'away';
        detail = rightText;
      } else {
        // Deteksi posisi dari class atau urutan elemen
        const htmlStr = (row.html() || '').toLowerCase();
        team = htmlStr.includes('right') || htmlStr.includes('away') ? 'away' : 'home';
        detail = cleanText(fullText.replace(new RegExp(`'?${minuteNum.replace('+', '\\+')}'?`, 'g'), ''));
      }

      const imgSrcs = row
        .find('img, i, svg')
        .map((__, icon) => `${$(icon).attr('src') || ''} ${$(icon).attr('alt') || ''} ${$(icon).attr('class') || ''}`)
        .get()
        .join(' ')
        .toLowerCase();

      const type = detectEventType((row.html() || '').toLowerCase(), imgSrcs, fullText.toLowerCase());
      const cleanDetail = cleanText(detail.replace(/^[-–•:]+\s*|\s*[-–•:]+$/g, ''));
      if (!cleanDetail) return;

      const eventKey = `${minute}-${team}-${type}-${cleanDetail}`;
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

    // 6. Susunan Pemain (#lineup / #matchlineup)
    let homeLineup = { formation: '', starting: [], substitutes: [] };
    let awayLineup = { formation: '', starting: [], substitutes: [] };

    const lineupRoot = $('#lineup, #matchlineup, .match-lineup, [id*="lineup"]').first();
    if (lineupRoot.length > 0) {
      // Cek apakah dipisah berdasarkan kolom kiri/kanan atau 2 sub-kontainer
      const leftCol = lineupRoot.find('.left, .home-lineup, .col-md-6:first-child, .col-6:first-child, .col-lg-6:first-child').first();
      const rightCol = lineupRoot.find('.right, .away-lineup, .col-md-6:last-child, .col-6:last-child, .col-lg-6:last-child').first();

      if (leftCol.length > 0 && rightCol.length > 0 && leftCol[0] !== rightCol[0]) {
        homeLineup = extractSideLineup($, leftCol);
        awayLineup = extractSideLineup($, rightCol);
      } else {
        const tablesOrLists = lineupRoot.find('table, ul');
        if (tablesOrLists.length >= 2) {
          homeLineup = extractSideLineup($, tablesOrLists.eq(0));
          awayLineup = extractSideLineup($, tablesOrLists.eq(1));
        } else {
          // Format 1 baris kiri-kanan (.left = home player, .right = away player)
          lineupRoot.find('li, tr').each((_, el) => {
            const leftEl = $(el).find('.left, td:first-child').first();
            const rightEl = $(el).find('.right, td:last-child').first();
            const hPlayer = leftEl.length ? parsePlayerRow($, leftEl) : null;
            const aPlayer = rightEl.length ? parsePlayerRow($, rightEl) : null;

            if (hPlayer) {
              if (homeLineup.starting.length < 11) homeLineup.starting.push(hPlayer);
              else homeLineup.substitutes.push(hPlayer);
            }
            if (aPlayer) {
              if (awayLineup.starting.length < 11) awayLineup.starting.push(aPlayer);
              else awayLineup.substitutes.push(aPlayer);
            }
          });
        }
      }
    }

    const hasLineups = homeLineup.starting.length > 0 || awayLineup.starting.length > 0;

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
        lineups: hasLineups
          ? {
              home: homeLineup,
              away: awayLineup
            }
          : null
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
