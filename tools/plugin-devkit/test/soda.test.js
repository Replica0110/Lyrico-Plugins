import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/plugin-loader.js';
import { createRuntime } from '../src/runtime.js';

const root = fileURLToPath(new URL('../../../soda/', import.meta.url));
const track = {
  id: '7679694801201334312', name: '测试', duration: 74712,
  artists: [{ name: '歌手' }],
  album: { name: '专辑', release_date: 1736899202,
    url_cover: { urls: ['https://p3-luna.douyinpic.com/img/'], uri: 'cover' } }
};
const response = body => ({ code: 200, body: JSON.stringify(body) });
async function runtime(get) {
  const result = await createRuntime(await loadPlugin(root));
  result.context.Platform.http.get = get;
  return result;
}

test('Soda searches Android endpoint, paginates and reads all track groups without PC credentials', async () => {
  const r = await runtime((url, options) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/luna/search/track');
    assert.equal(u.searchParams.get('device_platform'), 'android');
    assert.equal(u.searchParams.get('cursor'), '5');
    assert.equal(u.searchParams.get('count'), '5');
    assert.equal(u.searchParams.get('q'), '测试 & 歌手');
    assert.match(options.headers['User-Agent'], /com.luna.music/);
    assert.equal(options.headers['X-Helios'], undefined);
    return response({ result_groups: [{ data: [{ entity: {} }] },
      { data: Array.from({ length: 20 }, (_, i) => ({ entity: { track: { ...track, id: String(i) } } })) }] });
  });
  const songs = JSON.parse((await r.call('searchSongs', { keyword: '测试 & 歌手', page: 2, pageSize: 5 })).raw);
  assert.equal(songs.length, 5);
  assert.equal(songs[0].date, '2025-01-15');
  assert.equal(songs[0].duration, 74712);
});

test('Soda preserves explicit zero results but rejects empty, malformed and API error responses', async () => {
  for (const body of ['', 'null', '{}', '{', '{"status_code":5}', '{"status_info":{"status_code":5}}']) {
    const r = await runtime(() => ({ code: 200, body }));
    await assert.rejects(r.call('searchSongs', { keyword: 'test' }));
  }
  const r = await runtime(() => response({ result_groups: [] }));
  assert.equal((await r.call('searchSongs', { keyword: 'test' })).raw, '[]');
});

test('Soda SEO lyrics retain word timing and fill metadata for an ID-only song', async () => {
  for (const nested of [true, false]) {
    let count = 0;
    const r = await runtime(url => {
      count++;
      assert.equal(new URL(url).pathname, '/luna/h5/seo_track');
      assert.equal(new URL(url).searchParams.get('track_id'), track.id);
      const lyric = { content: '[1000,800]<0,400,0>你<400,400,0>好' };
      return response({ seo_track: { track, ...(nested ? { lyric } : {}) }, ...(nested ? {} : { lyric }) });
    });
    const lyrics = JSON.parse((await r.call('getLyrics', { song: { id: track.id } })).raw);
    assert.equal(count, 1);
    assert.equal(lyrics.length, 1);
    assert.deepEqual(lyrics[0].original[0], [1000, 1800, [[1000, 1400, '你'], [1400, 1800, '好']]]);
    assert.equal(lyrics[0].tags.date, '2025-01-15');
    assert.equal(lyrics[0].tags.al, '专辑');
  }
});

test('Soda falls back from blocked SEO to share lyrics even with legacy PC config', async () => {
  const urls = [];
  const r = await runtime(url => {
    urls.push(url);
    if (url.includes('seo_track')) return { code: 200, body: '' };
    return { code: 200, body: 'window._ROUTER_DATA = ' + JSON.stringify({ loaderData: {
      track_page: { audioWithLyricsOption: { lyrics: { sentences: [
        { startMs: 1000, words: [{ text: '你好' }] }
      ] } } }
    } }) + ';</script>' };
  });
  const lyrics = JSON.parse((await r.call('getLyrics', { config: { x_helios: 'old' },
    song: { id: track.id, title: '测试', artist: '歌手', album: '专辑', date: '2025' } })).raw);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /share\/track/);
  assert.equal(lyrics.length, 1);
});

test('Soda missing lyrics return no candidate and covers use normalized release dates', async () => {
  const r = await runtime(url => url.includes('search/track')
    ? response({ result_groups: [{ data: [{ entity: { track } }] }] })
    : url.includes('seo_track') ? response({ seo_track: { track }, lyric: {} })
    : { code: 200, body: 'window._ROUTER_DATA = {"loaderData":{}};' });
  assert.equal((await r.call('getLyrics', { song: { id: track.id } })).raw, '[]');
  const covers = JSON.parse((await r.call('searchCovers', { keyword: '测试' })).raw);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].date, '2025-01-15');
  assert.match(covers[0].picUrl, /~c5_1400x1400.jpg$/);
});
