const cheerio = require('cheerio');
const { httpClient } = require('../lib/httpClient');
const { normalizeUrl, cleanText, handleCors } = require('../lib/helpers');

const COMPETITION = 'BRI_SUPER_LEAGUE_2026-27';

function formatSlugName(slug) {
  if (!slug) return '';
  return slug.replace(/_+/g, ' ').trim();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return;

  try {
    const { status: filterStatus, week } = req.query;

    const targetPath = week
      ? `/fixtures/index/${COMPETITION}/${encodeURIComponent(week)}/0`
      : `/fixtures`;

    const response = await httpClient.get(targetPath);
    const $ = cheerio.load(response.data || '');

    const selectedWeek =
      week ||
      $('.fixtures-week-picker select option[selected]').attr('value') ||
      $('.fixtures-week-picker select option:selected').attr('value') ||
      null;

    const matches = [];
    const seen = new Set();

    $('a[href*="/result/detail/"]').each((i, el) => {
      const linkEl = $(el);
      const href = linkEl.attr('href') || '';
      if (!href || seen.has(href)) return;
      seen.add(href);

      const urlParts = href.replace(/\/$/, '').split('/');
      const detailIdx = urlParts.indexOf('detail');
      const dateFromUrl = detailIdx !== -1 ? urlParts[detailIdx + 2] : null;
      const homeSlug = detailIdx !== -1 ? urlParts[detailIdx + 3] : null;
      const awaySlug = detailIdx !== -1 ? urlParts[detailIdx + 4] : null;
      const matchId =
        detailIdx !== -1
          ? urlParts.slice(detailIdx + 2).join('/')
          : `match-${i + 1}`;

      const imgs = linkEl.find('img').filter((_, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src') || '';
        return src && !src.includes('flagcdn.com');
      });

      const homeLogo = normalizeUrl($(imgs[0]).attr('data-src') || $(imgs[0]).attr('src'));
      const awayLogo = normalizeUrl($(imgs[1]).attr('data-src') || $(imgs[1]).attr('src'));

      const fullText = cleanText(linkEl.text());
      const scoreMatch = fullText.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
      const timeMatch = fullText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);

      const isLive = /\b(LIVE|HT|BERLANGSUNG|\d{1,3}')\b/i.test(fullText);
      const isFinished = /\b(FT|SELESAI|FULL TIME)\b/i.test(fullText);

      let status = 'UPCOMING';
      if (isLive) {
        status = 'LIVE';
      } else if (isFinished || (scoreMatch && !timeMatch)) {
        status = 'FINISHED';
      }

      const homeName = formatSlugName(homeSlug) || cleanText($(imgs[0]).attr('alt'));
      const awayName = formatSlugName(awaySlug) || cleanText($(imgs[1]).attr('alt'));

      // Ekstrak nama stadion dari teks setelah nama tim tamu
      let venue = null;
      if (awayName) {
        const afterAwayRegex = new RegExp(`${escapeRegExp(awayName)}\\s+(.+)$`, 'i');
        const venueMatch = fullText.match(afterAwayRegex);
        if (venueMatch && venueMatch[1]) {
          venue = cleanText(venueMatch[1]);
        }
      }

      matches.push({
        id: matchId,
        status,
        matchweek: selectedWeek ? `Pekan ${selectedWeek}` : null,
        week_number: selectedWeek ? parseInt(selectedWeek, 10) : null,
        date: dateFromUrl,
        time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null,
        venue,
        home: {
          name: homeName,
          logo: homeLogo,
          score: scoreMatch && status !== 'UPCOMING' ? parseInt(scoreMatch[1], 10) : null
        },
        away: {
          name: awayName,
          logo: awayLogo,
          score: scoreMatch && status !== 'UPCOMING' ? parseInt(scoreMatch[2], 10) : null
        },
        detail_url: normalizeUrl(href)
      });
    });

    const filtered = filterStatus
      ? matches.filter((m) => m.status.toLowerCase() === filterStatus.toLowerCase())
      : matches;

    res.status(200).json({
      success: true,
      source: 'ileague.id',
      competition: COMPETITION,
      week: selectedWeek ? parseInt(selectedWeek, 10) : null,
      updated_at: new Date().toISOString(),
      total: filtered.length,
      data: filtered
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data pertandingan dari ileague.id',
      error: error.message
    });
  }
};
