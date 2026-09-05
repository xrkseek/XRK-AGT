// @ts-nocheck
import { fetchWithPolicy } from '#utils/fetch-with-retry.js'

const SEARCH_API = 'https://music.163.com/api/search/get'
const SONG_URL_API = 'https://music.163.com/song/media/outer/url'
const LIMIT = 5
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://music.163.com/' }

export class MusicPlugin extends PluginBase {
  constructor() {
    super({
      name: '点歌插件',
      dsc: '搜索后回复数字选择',
      event: 'message',
      priority: 5000,
      rule: [{ reg: '^#点歌\\s*(.+)$', fnc: 'searchMusic' }]
    })
  }

  async searchMusic() {
    const keyword = (this.e.msg || '').replace(/^#点歌\s*/, '').trim()
    if (!keyword) {
      await this.reply('请输入歌曲名，例：#点歌青花瓷')
      return false
    }

    try {
      const url = `${SEARCH_API}?s=${encodeURIComponent(keyword)}&type=1&limit=${LIMIT}`
      const res = await fetchWithPolicy(url, { headers: HEADERS, timeoutMs: 8000, retries: 1 })
      const data = await res.json()
      const songs = data.result?.songs
      if (!songs?.length) {
        await this.reply('未找到相关歌曲，换关键词试试')
        return false
      }

      const lines = songs.map((s, i) => `${i + 1}. ${s.name} - ${s.artists.map(a => a.name).join('、')}`)
      this.e._musicSearchResults = songs
      this.setContext('musicChooseContext', false, 60, '选择超时已取消')
      await this.reply(['搜索结果：', ...lines, '回复数字选择'].join('\n'))
      return true
    } catch (err) {
      logger.error(`点歌搜索失败: ${err.message}`)
      await this.reply('点歌失败，请稍后再试')
      return false
    }
  }

  async musicChooseContext(stored) {
    const list = stored?._musicSearchResults
    if (!list?.length) return false

    const raw = (this.e?.msg || this.e?.plainText || '').trim()
    const num = parseInt(raw, 10)
    if (Number.isNaN(num) || num < 1 || num > list.length) {
      await this.reply('请输入有效序号数字')
      return true
    }

    const song = list[num - 1]
    const artist = song.artists.map(a => a.name).join('、')
    const songUrl = `${SONG_URL_API}?id=${song.id}.mp3`
    await this.reply([`🎵 ${song.name} - ${artist}`, msgSegment.record(songUrl, song.name)])
    this.finish('musicChooseContext')
    return true
  }
}
