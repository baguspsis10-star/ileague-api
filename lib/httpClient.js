const axios = require('axios');

const BASE_URL = 'https://ileague.id';

const httpClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://ileague.id/',
    'Cache-Control': 'no-cache'
  }
});

module.exports = { httpClient, BASE_URL };
