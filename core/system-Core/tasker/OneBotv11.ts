// @ts-nocheck
import path from "node:path"
import { ulid } from "ulid"
import { collectForwardIds as collectForwardIdsShared } from "#utils/onebot-message-seg.js"

/** NapCat 出站：url/path 优先；Buffer 勿 String()（TRSS 直传 makeFile） */
function pickOutboundFileRef(data) {
  if (!data || typeof data !== "object") return data?.file
  const raw = data.file
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return raw
  const file = typeof raw === "string" ? raw.trim() : ""
  if (file.startsWith("base64://")) return file
  const url = String(data.url ?? "").trim()
  const p = String(data.path ?? "").trim()
  if (/^https?:\/\//i.test(file)) return file
  if (/^https?:\/\//i.test(url)) return url
  if (p) return p
  return file || url || p || undefined
}

const RICH_MEDIA = new Set(["image", "video", "record", "file"])

AgentRuntime.tasker.push(
  new (class OneBotv11Tasker {
    id = "QQ"
    name = "OneBotv11"
    path = this.name
    echo = new Map()
    timeout = 360000

    /**
     * 生成日志消息（隐藏base64内容）
     */
    makeLog(msg) {
      return AgentRuntime.String(msg).replace(/base64:\/\/.*?(,|]|")/g, "base64://...$1")
    }

    /**
     * 发送API请求
     */
    sendApi(data, ws, action, params = {}) {
      const echo = ulid()
      const request = { action, params, echo }
      ws.sendMsg(request)
      const cache = Promise.withResolvers()
      this.echo.set(echo, cache)
      const timeout = setTimeout(() => {
        cache.reject(AgentRuntime.makeError("请求超时", request, { timeout: this.timeout }))
        AgentRuntime.makeLog("warn", [`API调用超时: ${action}`, request], data.self_id)
        this.echo.delete(echo)
      }, this.timeout)

      return cache.promise
        .then(data => {
          if (data.retcode !== 0 && data.retcode !== 1)
            throw AgentRuntime.makeError(data.msg || data.wording || 'API 失败', 'ApiError', {
              action,
              echo: data.echo,
              retcode: data.retcode,
              error: data,
            })
          return data.data
            ? new Proxy(data, {
              get: (target, prop) => target.data[prop] ?? target[prop],
            })
            : data
        })
        .catch(err => {
          AgentRuntime.makeLog("warn", [`API调用失败: ${action}`, err.message], data.self_id)
          throw err
        })
        .finally(() => {
          clearTimeout(timeout)
          this.echo.delete(echo)
        })
    }

    async makeFile(file, opts = {}) {
      file = await AgentRuntime.Buffer(file, {
        http: true,
        size: opts.preferPath ? 1 : 1048576,
        ...opts,
      })
      if (Buffer.isBuffer(file)) return `base64://${file.toBase64()}`
      if (typeof file === "string" && file.startsWith("file://")) return file.slice(7)
      return file
    }

    async makeMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const msgs = []
      const forward = []
      for (let i of msg) {
        if (Buffer.isBuffer(i) || i instanceof Uint8Array) {
          i = { type: "image", data: { file: i } }
        } else if (typeof i !== "object") {
          i = { type: "text", data: { text: i } }
        } else if (!i.data) {
          i = { type: i.type, data: { ...i, type: undefined } }
        }

        switch (i.type) {
          case "at":
            i.data.qq = String(i.data.qq)
            break
          case "reply":
            i.data.id = String(i.data.id)
            break
          case "button":
            continue
          case "node":
            forward.push(...i.data)
            continue
          case "forward": {
            const fid = String(i.data?.id ?? i.data?.message_id ?? "").trim()
            if (fid) {
              // 裸 forward：保留段交给协议端按 id 转发；无法直发时由 sendForwardMsg 路径处理
              i.data = { id: fid, message_id: fid }
              msgs.push(i)
            } else {
              AgentRuntime.makeLog(
                "warn",
                `忽略无 id 的 forward 段`,
                "OneBotv11",
              )
            }
            continue
          }
          case "raw":
            i = i.data
            break
        }

        const fileRef = pickOutboundFileRef(i.data)
        if (fileRef != null && fileRef !== "") {
          i.data.file = await this.makeFile(fileRef, RICH_MEDIA.has(i.type) ? { preferPath: true } : {})
        }
        msgs.push(i)
      }
      return [msgs, forward]
    }

    /**
     * 发送消息（支持普通和转发）
     */
    async sendMsg(msg, send, sendForwardMsg) {
      const [message, forward] = await this.makeMsg(msg)
      const ret = []

      if (forward.length) {
        const data = await sendForwardMsg(forward)
        if (Array.isArray(data)) ret.push(...data)
        else ret.push(data)
      }

      if (message.length) ret.push(await send(message))
      if (ret.length === 1) return ret[0]

      const message_id = []
      for (const i of ret) if (i?.message_id) message_id.push(i.message_id)
      return { data: ret, message_id }
    }

    sendFriendMsg(data, msg) {
      if (msg && typeof msg === 'object' && msg.type === "poke" && (msg.qq || msg.user_id)) {
        return this.sendPoke(data, msg.qq || msg.user_id)
      }
      return this.sendMsg(
        msg,
        message => {
          AgentRuntime.makeLog(
            "info",
            `发送好友消息：${this.makeLog(message)}`,
            `${data.self_id} => ${data.user_id}`,
            true,
          )
          return data.bot.sendApi("send_msg", {
            user_id: data.user_id,
            message,
          })
        },
        msg => this.sendFriendForwardMsg(data, msg),
      )
    }

    sendGroupMsg(data, msg) {
      if (msg && typeof msg === 'object' && msg.type === "poke" && msg.qq) {
        return this.sendPoke(data, msg.qq)
      }
      return this.sendMsg(
        msg,
        message => {
          AgentRuntime.makeLog(
            "info",
            `发送群消息：${this.makeLog(message)}`,
            `${data.self_id} => ${data.group_id}`,
            true,
          )
          return data.bot.sendApi("send_msg", {
            group_id: data.group_id,
            message,
          })
        },
        msg => this.sendGroupForwardMsg(data, msg),
      )
    }

    sendPoke(data, user_id) {
      const target = Number(user_id)
      const params = data.group_id
        ? { group_id: data.group_id, user_id: target }
        : { user_id: target }
      AgentRuntime.makeLog("info", `发送戳一戳：${user_id}`, data.group_id ? `${data.self_id} => ${data.group_id}` : `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_poke", params)
    }

    sendGuildMsg(data, msg) {
      return this.sendMsg(
        msg,
        message => {
          AgentRuntime.makeLog(
            "info",
            `发送频道消息：${this.makeLog(message)}`,
            `${data.self_id}] => ${data.guild_id}-${data.channel_id}`,
            true,
          )
          return data.bot.sendApi("send_guild_channel_msg", {
            guild_id: data.guild_id,
            channel_id: data.channel_id,
            message,
          })
        },
        msg => AgentRuntime.sendForwardMsg(msg => this.sendGuildMsg(data, msg), msg),
      )
    }

    async recallMsg(data, message_id) {
      // NapCat delete_msg：message_id 须为短整型（Number）；见官方 DeleteMsg
      if (!Array.isArray(message_id)) message_id = [message_id]
      const msgs = []
      for (const raw of message_id) {
        const id = Number(raw)
        if (!Number.isFinite(id)) {
          AgentRuntime.makeLog("warn", `撤回跳过：非法 message_id=${raw}`, data.self_id)
          msgs.push(null)
          continue
        }
        AgentRuntime.makeLog("info", `撤回消息：${id}`, data.self_id)
        try {
          const result = await data.bot.sendApi("delete_msg", { message_id: id })
          msgs.push(result)
        } catch (err) {
          AgentRuntime.makeLog("warn", `撤回消息失败: ${err.message}`, data.self_id)
          msgs.push(null)
        }
      }
      return msgs
    }

    /**
     * 统一消息段：兼容 { type, data } 与 NapCat 扁平 { type, file, url, ... }
     */
    normalizeMsgSegment(seg) {
      if (!seg || typeof seg !== "object") {
        return { type: "text", text: String(seg ?? "") }
      }
      if (seg.data && typeof seg.data === "object" && !Array.isArray(seg.data)) {
        return { ...seg.data, type: seg.type }
      }
      const { type, data: _data, ...fields } = seg
      return { type, ...fields }
    }

    /** 从 raw_message CQ 串解析（get_msg 仅返回字符串时的兜底） */
    parseCQMsg(raw) {
      const text = String(raw ?? "")
      if (!text.includes("[CQ:")) return [{ type: "text", text }]
      const segments = []
      const re = /\[CQ:([\w]+),([^\]]+)\]/g
      let last = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) {
          const chunk = text.slice(last, m.index)
          if (chunk) segments.push({ type: "text", text: chunk })
        }
        const type = m[1]
        const body = m[2]
        const seg = { type }
        if (type === "image" || type === "mface") {
          seg.file = body.match(/(?:^|,)file=([^,]+)/)?.[1]
          seg.url = body.match(/url=(https?:\/\/[^,\]]+)/)?.[1]
          const sub = body.match(/(?:^|,)sub_type=(\d+)/)?.[1]
          if (sub != null) seg.sub_type = Number(sub)
          seg.summary = body.match(/(?:^|,)summary=([^,]+)/)?.[1]
        } else {
          for (const part of body.split(",")) {
            const eq = part.indexOf("=")
            if (eq === -1) continue
            seg[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
          }
        }
        segments.push(seg)
        last = m.index + m[0].length
      }
      if (last < text.length) {
        const tail = text.slice(last)
        if (tail) segments.push({ type: "text", text: tail })
      }
      return segments.length ? segments : [{ type: "text", text }]
    }

    /**
     * 解析消息内容
     */
    parseMsg(msg) {
      const array = []
      for (const i of Array.isArray(msg) ? msg : [msg]) {
        if (typeof i === "object" && i !== null) {
          array.push(this.normalizeMsgSegment(i))
        } else {
          const s = String(i)
          if (s.includes("[CQ:")) {
            array.push(...this.parseCQMsg(s))
          } else {
            array.push({ type: "text", text: s })
          }
        }
      }
      return array
    }

    async getMsg(data, message_id) {
      const res = await data.bot.sendApi("get_msg", { message_id })
      const msg = res?.data
      if (!msg) return null
      if (msg.message) {
        msg.message = this.parseMsg(msg.message)
        const cqInText = msg.message.length === 1
          && msg.message[0]?.type === "text"
          && String(msg.message[0].text).includes("[CQ:")
        if (cqInText && msg.raw_message) {
          msg.message = this.parseCQMsg(msg.raw_message)
        }
      } else if (msg.raw_message) {
        msg.message = this.parseCQMsg(msg.raw_message)
      }
      return msg
    }

    async getFriendMsgHistory(data, message_seq, count, reverseOrder = true) {
      const msgs = (
        await data.bot.sendApi("get_friend_msg_history", {
          user_id: data.user_id,
          message_seq,
          count,
          reverseOrder,
        })
      ).data?.messages

      for (const i of Array.isArray(msgs) ? msgs : [msgs])
        if (i?.message) i.message = this.parseMsg(i.message)
      return msgs
    }

    async getGroupMsgHistory(data, message_seq, count, reverseOrder = true) {
      const msgs = (
        await data.bot.sendApi("get_group_msg_history", {
          group_id: data.group_id,
          message_seq,
          count,
          reverseOrder,
        })
      ).data?.messages

      for (const i of Array.isArray(msgs) ? msgs : [msgs])
        if (i?.message) i.message = this.parseMsg(i.message)
      return msgs
    }

    /** 收集 forward 段所有可用的 message_id */
    collectForwardIds(seg, contextMessageId) {
      return collectForwardIdsShared(seg, contextMessageId)
    }

    /** 拉取聊天记录，支持多 ID 回退与嵌套展开 */
    async getForwardMsg(data, message_id, depth = 0, altIds = []) {
      if (depth > 8) {
        AgentRuntime.makeLog("warn", "getForwardMsg 嵌套层级过深，已停止展开", data.self_id)
        return []
      }

      const ids = this.collectForwardIds(
        typeof message_id === "object" ? message_id : { id: message_id },
        null,
      )
      for (const alt of Array.isArray(altIds) ? altIds : []) {
        if (alt != null && alt !== "") ids.push(String(alt))
      }
      const uniqueIds = [...new Set(ids)]

      let msgs
      let lastErr
      for (const id of uniqueIds) {
        try {
          const res = await data.bot.sendApi("get_forward_msg", { message_id: id })
          if (Array.isArray(res?.data?.messages) && res.data.messages.length) {
            msgs = res.data.messages
            break
          }
        } catch (err) {
          lastErr = err
        }
      }
      if (!msgs) {
        if (lastErr) throw lastErr
        return []
      }

      for (const i of msgs) {
        if (i.message) i.message = this.parseMsg(i.message || i.content)
        i.message = await this.expandForwardSegments(data, i.message, depth)
      }
      return msgs
    }

    /** 展开消息段中的嵌套聊天记录（forward / node） */
    async expandForwardSegments(data, segments, depth) {
      if (!Array.isArray(segments) || !segments.length) return segments
      const result = []
      for (const seg of segments) {
        if (!seg || typeof seg !== "object") {
          result.push(seg)
          continue
        }

        if (seg.type === "forward") {
          const ids = this.collectForwardIds(seg, null)
          let expanded = false
          for (const id of ids) {
            try {
              const nested = await this.getForwardMsg(data, id, depth + 1)
              if (nested.length) {
                result.push({ type: "node", data: nested })
                expanded = true
                break
              }
            } catch (err) {
              AgentRuntime.makeLog(
                "warn",
                `展开嵌套聊天记录失败 id=${id}: ${err.message}`,
                data.self_id,
              )
            }
          }
          if (expanded) continue
        }

        if (seg.type === "node" && Array.isArray(seg.data)) {
          const nodes = []
          for (const node of seg.data) {
            const inner = Array.isArray(node.message)
              ? node.message
              : Array.isArray(node.content)
                ? node.content
                : []
            nodes.push({
              ...node,
              message: await this.expandForwardSegments(data, inner, depth),
            })
          }
          result.push({ type: "node", data: nodes })
          continue
        }

        result.push(seg)
      }
      return result
    }

    /**
     * 构建转发消息
     */
    async makeForwardMsg(msg) {
      const msgs = []
      for (const i of msg) {
        const [content, forward] = await this.makeMsg(i.message)
        if (forward.length) msgs.push(...(await this.makeForwardMsg(forward)))
        if (content.length)
          msgs.push({
            type: "node",
            data: {
              name: i.nickname || "匿名消息",
              uin: String(Number(i.user_id) || 80000000),
              content,
              time: i.time,
            },
          })
      }
      return msgs
    }

    async sendFriendForwardMsg(data, msg) {
      AgentRuntime.makeLog(
        "info",
        `发送好友转发消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.user_id}`,
        true,
      )
      return data.bot.sendApi("send_private_forward_msg", {
        user_id: data.user_id,
        messages: await this.makeForwardMsg(msg),
      })
    }

    async sendGroupForwardMsg(data, msg) {
      AgentRuntime.makeLog(
        "info",
        `发送群转发消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      return data.bot.sendApi("send_group_forward_msg", {
        group_id: data.group_id,
        messages: await this.makeForwardMsg(msg),
      })
    }

    async getFriendArray(data) {
      try {
        const result = await data.bot.sendApi("get_friend_list");
        return result?.data || [];
      } catch (err) {
        AgentRuntime.makeLog("error", `获取好友列表失败: ${err.message}`, data.self_id);
        return [];
      }
    }

    async getFriendList(data) {
      const array = [];
      const friendArray = await this.getFriendArray(data);
      if (Array.isArray(friendArray)) {
        for (const item of friendArray) {
          if (item?.user_id !== undefined) {
            array.push(item.user_id);
          }
        }
      }
      return array;
    }

    async getFriendMap(data) {
      const map = new Map();
      const friendArray = await this.getFriendArray(data);
      if (Array.isArray(friendArray)) {
        for (const i of friendArray) {
          if (i?.user_id !== undefined) {
            map.set(i.user_id, i);
          }
        }
      }
      data.bot.fl = map;
      return map;
    }

    async getFriendInfo(data) {
      try {
        const info = (
          await data.bot.sendApi("get_stranger_info", {
            user_id: data.user_id,
          })
        ).data;
        if (info) {
          data.bot.fl.set(data.user_id, info);
        }
        return info;
      } catch (err) {
        AgentRuntime.makeLog("error", `获取好友信息失败: ${err.message}`, data.self_id);
        return null;
      }
    }

    async getGroupArray(data) {
      let array = [];
      try {
        const result = await data.bot.sendApi("get_group_list");
        array = result?.data || [];
      } catch (err) {
        AgentRuntime.makeLog("error", `获取群列表失败: ${err.message}`, data.self_id);
        array = [];
      }

      try {
        const guildArray = await this.getGuildArray(data);
        if (Array.isArray(guildArray)) {
          for (const guild of guildArray) {
            try {
              const channels = await this.getGuildChannelArray({
                ...data,
                guild_id: guild.guild_id,
              });
              if (Array.isArray(channels)) {
                for (const channel of channels) {
                  array.push({
                    guild,
                    channel,
                    group_id: `${guild.guild_id}-${channel.channel_id}`,
                    group_name: `${guild.guild_name}-${channel.channel_name}`,
                  });
                }
              }
            } catch {
            }
          }
        }
      } catch {
      }

      return array;
    }

    async getGroupList(data) {
      const array = [];
      const groupArray = await this.getGroupArray(data);
      if (Array.isArray(groupArray)) {
        for (const item of groupArray) {
          if (item?.group_id !== undefined) {
            array.push(item.group_id);
          }
        }
      }
      return array;
    }

    async getGroupMap(data) {
      const map = new Map();
      const groupArray = await this.getGroupArray(data);
      if (Array.isArray(groupArray)) {
        for (const i of groupArray) {
          if (i?.group_id !== undefined) {
            map.set(i.group_id, i);
          }
        }
      }
      data.bot.gl = map;
      return map;
    }

    async getGroupInfo(data) {
      try {
        const info = (
          await data.bot.sendApi("get_group_info", {
            group_id: data.group_id,
          })
        ).data;
        if (info) {
          data.bot.gl.set(data.group_id, info);
        }
        return info;
      } catch (err) {
        AgentRuntime.makeLog("error", `获取群信息失败: ${err.message}`, data.self_id);
        return null;
      }
    }

    async getMemberArray(data) {
      try {
        const result = await data.bot.sendApi("get_group_member_list", {
          group_id: data.group_id,
        });
        return result?.data || [];
      } catch (err) {
        AgentRuntime.makeLog("error", `获取群成员列表失败: ${err.message}`, data.self_id);
        return [];
      }
    }

    async getMemberList(data) {
      const array = [];
      const memberArray = await this.getMemberArray(data);
      if (Array.isArray(memberArray)) {
        for (const item of memberArray) {
          if (item?.user_id !== undefined) {
            array.push(item.user_id);
          }
        }
      }
      return array;
    }

    async getMemberMap(data) {
      const map = new Map();
      const memberArray = await this.getMemberArray(data);
      if (Array.isArray(memberArray)) {
        for (const i of memberArray) {
          if (i?.user_id !== undefined) {
            map.set(i.user_id, i);
          }
        }
      }
      if (!data.bot.gml) {
        data.bot.gml = new Map();
      }
      data.bot.gml.set(data.group_id, map);
      return map;
    }

    /**
     * 获取所有群的成员映射表
     */
    async getGroupMemberMap(data) {
      await this.getGroupMap(data);

      if (!data.bot.gml) {
        data.bot.gml = new Map();
      }

      for (const [group_id, group] of data.bot.gl) {
        if (group?.guild) continue;
        try {
          await this.getMemberMap({ ...data, group_id });
          AgentRuntime.makeLog("debug", `已加载群 ${group_id} 的成员列表`, data.self_id);
        } catch (err) {
          AgentRuntime.makeLog("error", `加载群 ${group_id} 成员失败: ${err.message}`, data.self_id);
        }
      }

      return data.bot.gml;
    }

    async getMemberInfo(data) {
      try {
        const info = (
          await data.bot.sendApi("get_group_member_info", {
            group_id: data.group_id,
            user_id: data.user_id,
          })
        ).data;

        if (!data.bot.gml) {
          data.bot.gml = new Map();
        }

        let gml = data.bot.gml.get(data.group_id);
        if (!gml) {
          gml = new Map();
          data.bot.gml.set(data.group_id, gml);
        }

        if (info) {
          gml.set(data.user_id, info);
        }

        return info;
      } catch (err) {
        AgentRuntime.makeLog("error", `获取群成员信息失败: ${err.message}`, data.self_id);
        return null;
      }
    }

    async getGuildArray(data) {
      try {
        const result = await data.bot.sendApi("get_guild_list");
        return result?.data || [];
      } catch (err) {
        AgentRuntime.makeLog("debug", `获取频道列表失败: ${err.message}`, data.self_id);
        return [];
      }
    }

    getGuildInfo(data) {
      return data.bot.sendApi("get_guild_meta_by_guest", {
        guild_id: data.guild_id,
      });
    }

    async getGuildChannelArray(data) {
      try {
        const result = await data.bot.sendApi("get_guild_channel_list", {
          guild_id: data.guild_id,
        });
        return result?.data || [];
      } catch (err) {
        AgentRuntime.makeLog("debug", `获取子频道列表失败: ${err.message}`, data.self_id);
        return [];
      }
    }

    async getGuildChannelList(data) {
      const array = [];
      const channelArray = await this.getGuildChannelArray(data);
      if (Array.isArray(channelArray)) {
        for (const item of channelArray) {
          if (item?.channel_id !== undefined) {
            array.push(item.channel_id);
          }
        }
      }
      return array;
    }

    async getGuildChannelMap(data) {
      const map = new Map();
      const channelArray = await this.getGuildChannelArray(data);
      if (Array.isArray(channelArray)) {
        for (const i of channelArray) {
          if (i?.channel_id !== undefined) {
            map.set(i.channel_id, i);
          }
        }
      }
      return map;
    }

    async getGuildMemberArray(data) {
      const array = [];
      let next_token = "";

      while (true) {
        try {
          const result = await data.bot.sendApi("get_guild_member_list", {
            guild_id: data.guild_id,
            next_token,
          });

          const list = result?.data;
          if (!list) break;

          if (Array.isArray(list.members)) {
            for (const i of list.members) {
              array.push({
                ...i,
                user_id: i.tiny_id,
              });
            }
          }

          if (list.finished) break;
          next_token = list.next_token;
        } catch (err) {
          AgentRuntime.makeLog("debug", `获取频道成员列表失败: ${err.message}`, data.self_id);
          break;
        }
      }

      return array;
    }

    async getGuildMemberList(data) {
      const array = [];
      const memberArray = await this.getGuildMemberArray(data);
      if (Array.isArray(memberArray)) {
        for (const item of memberArray) {
          if (item?.user_id !== undefined) {
            array.push(item.user_id);
          }
        }
      }
      return array;
    }

    async getGuildMemberMap(data) {
      const map = new Map();
      const memberArray = await this.getGuildMemberArray(data);
      if (Array.isArray(memberArray)) {
        for (const i of memberArray) {
          if (i?.user_id !== undefined) {
            map.set(i.user_id, i);
          }
        }
      }
      if (!data.bot.gml) {
        data.bot.gml = new Map();
      }
      data.bot.gml.set(data.group_id, map);
      return map;
    }

    getGuildMemberInfo(data) {
      return data.bot.sendApi("get_guild_member_profile", {
        guild_id: data.guild_id,
        user_id: data.user_id,
      });
    }
    setProfile(data, profile) {
      AgentRuntime.makeLog("info", `设置资料：${AgentRuntime.String(profile)}`, data.self_id)
      return data.bot.sendApi("set_qq_profile", profile)
    }

    async setAvatar(data, file) {
      AgentRuntime.makeLog("info", `设置头像：${file}`, data.self_id)
      return data.bot.sendApi("set_qq_avatar", {
        file: await this.makeFile(file),
      })
    }

    sendLike(data, times) {
      AgentRuntime.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_like", {
        user_id: data.user_id,
        times,
      })
    }

    setGroupName(data, group_name) {
      AgentRuntime.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_name", {
        group_id: data.group_id,
        group_name,
      })
    }

    async setGroupAvatar(data, file) {
      AgentRuntime.makeLog("info", `设置群头像：${file}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_portrait", {
        group_id: data.group_id,
        file: await this.makeFile(file),
      })
    }

    setGroupAdmin(data, user_id, enable) {
      AgentRuntime.makeLog(
        "info",
        `${enable ? "设置" : "取消"}群管理员：${user_id}`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      return data.bot.sendApi("set_group_admin", {
        group_id: data.group_id,
        user_id,
        enable,
      })
    }

    setGroupCard(data, user_id, card) {
      AgentRuntime.makeLog(
        "info",
        `设置群名片：${card}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true,
      )
      return data.bot.sendApi("set_group_card", {
        group_id: data.group_id,
        user_id,
        card,
      })
    }

    setGroupTitle(data, user_id, special_title, duration) {
      AgentRuntime.makeLog(
        "info",
        `设置群头衔：${special_title} ${duration}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true,
      )
      return data.bot.sendApi("set_group_special_title", {
        group_id: data.group_id,
        user_id,
        special_title,
        duration,
      })
    }

    sendGroupSign(data) {
      AgentRuntime.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_sign", {
        group_id: data.group_id,
      })
    }

    setGroupBan(data, user_id, duration) {
      AgentRuntime.makeLog(
        "info",
        `禁言群成员：${duration}秒`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true,
      )
      return data.bot.sendApi("set_group_ban", {
        group_id: data.group_id,
        user_id,
        duration,
      })
    }

    setGroupWholeKick(data, enable) {
      AgentRuntime.makeLog(
        "info",
        `${enable ? "开启" : "关闭"}全员禁言`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      return data.bot.sendApi("set_group_whole_ban", {
        group_id: data.group_id,
        enable,
      })
    }

    setGroupKick(data, user_id, reject_add_request) {
      AgentRuntime.makeLog(
        "info",
        `踢出群成员${reject_add_request ? "拒绝再次加群" : ""}`,
        `${data.self_id} => ${data.group_id}, ${user_id}`,
        true,
      )
      return data.bot.sendApi("set_group_kick", {
        group_id: data.group_id,
        user_id,
        reject_add_request,
      })
    }

    setGroupLeave(data, is_dismiss) {
      AgentRuntime.makeLog("info", is_dismiss ? "解散" : "退群", `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_leave", {
        group_id: data.group_id,
        is_dismiss,
      })
    }

    downloadFile(data, url, thread_count, headers) {
      return data.bot.sendApi("download_file", {
        url,
        thread_count,
        headers,
      })
    }

    async sendFriendFile(data, file, name = path.basename(file)) {
      AgentRuntime.makeLog(
        "info",
        `发送好友文件：${name}(${file})`,
        `${data.self_id} => ${data.user_id}`,
        true,
      )
      return data.bot.sendApi("upload_private_file", {
        user_id: data.user_id,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    async sendGroupFile(data, file, folder, name = path.basename(file)) {
      AgentRuntime.makeLog(
        "info",
        `发送群文件：${folder || ""}/${name}(${file})`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      return data.bot.sendApi("upload_group_file", {
        group_id: data.group_id,
        folder,
        file: (await this.makeFile(file, { file: true })).replace("file://", ""),
        name,
      })
    }

    deleteGroupFile(data, file_id, busid) {
      AgentRuntime.makeLog(
        "info",
        `删除群文件：${file_id}(${busid})`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      return data.bot.sendApi("delete_group_file", {
        group_id: data.group_id,
        file_id,
        busid,
      })
    }

    createGroupFileFolder(data, name) {
      AgentRuntime.makeLog("info", `创建群文件夹：${name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("create_group_file_folder", {
        group_id: data.group_id,
        name,
      })
    }

    getGroupFileSystemInfo(data) {
      return data.bot.sendApi("get_group_file_system_info", {
        group_id: data.group_id,
      })
    }

    getGroupFiles(data, folder_id) {
      if (folder_id)
        return data.bot.sendApi("get_group_files_by_folder", {
          group_id: data.group_id,
          folder_id,
        })
      return data.bot.sendApi("get_group_root_files", {
        group_id: data.group_id,
      })
    }

    getGroupFileUrl(data, file_id, busid) {
      return data.bot.sendApi("get_group_file_url", {
        group_id: data.group_id,
        file_id,
        busid,
      })
    }

    getGroupFs(data) {
      return {
        upload: this.sendGroupFile.bind(this, data),
        rm: this.deleteGroupFile.bind(this, data),
        rmdir: this.deleteGroupFileFolder.bind(this, data),
        mkdir: this.createGroupFileFolder.bind(this, data),
        df: this.getGroupFileSystemInfo.bind(this, data),
        ls: this.getGroupFiles.bind(this, data),
        download: this.getGroupFileUrl.bind(this, data),
        move: this.moveGroupFile.bind(this, data),
        rename: this.renameGroupFile.bind(this, data),
        save: this.saveFileToCache.bind(this, data),
        getInfo: this.getFileInfo.bind(this, data),
      }
    }

    deleteFriend(data) {
      AgentRuntime.makeLog("info", "删除好友", `${data.self_id} => ${data.user_id}`, true)
      return data.bot
        .sendApi("delete_friend", { user_id: data.user_id })
        .finally(this.getFriendMap.bind(this, data))
    }

    setFriendAddRequest(data, flag, approve, remark) {
      return data.bot.sendApi("set_friend_add_request", {
        flag,
        approve,
        remark,
      })
    }

    setGroupAddRequest(data, flag, approve, reason, sub_type = "add") {
      return data.bot.sendApi("set_group_add_request", {
        flag,
        sub_type,
        approve,
        reason,
      })
    }

    getGroupHonorInfo(data) {
      return data.bot.sendApi("get_group_honor_info", { group_id: data.group_id })
    }

    getEssenceMsg(data) {
      return data.bot.sendApi("get_essence_msg_list", { group_id: data.group_id })
    }

    setEssenceMsg(data, message_id) {
      return data.bot.sendApi("set_essence_msg", { message_id })
    }

    deleteEssenceMsg(data, message_id) {
      return data.bot.sendApi("delete_essence_msg", { message_id })
    }

    setEmojiLike(data, message_id, emoji_id, set = true) {
      AgentRuntime.makeLog("info", `设置表情回应：${emoji_id} (${set ? '贴' : '取消'})`, `${data.self_id} => ${data.group_id}, ${message_id}`, true)
      return data.bot.sendApi("set_msg_emoji_like", {
        message_id: String(message_id),
        emoji_id: Number(emoji_id),
        set: Boolean(set)
      })
    }

    
    setGroupKickMembers(data, user_ids) {
      AgentRuntime.makeLog("info", `批量踢出群成员：${user_ids.length}人`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_kick_members", {
        group_id: data.group_id,
        user_ids: Array.isArray(user_ids) ? user_ids : [user_ids]
      })
    }

    getGroupInfoEx(data) {
      return data.bot.sendApi("get_group_info_ex", {
        group_id: data.group_id
      })
    }

    getGroupAtAllRemain(data) {
      return data.bot.sendApi("get_group_at_all_remain", {
        group_id: data.group_id
      })
    }

    getGroupBanList(data) {
      return data.bot.sendApi("get_group_ban_list", {
        group_id: data.group_id
      })
    }

    setGroupTodo(data, content) {
      AgentRuntime.makeLog("info", `设置群代办：${content}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_todo", {
        group_id: data.group_id,
        content
      })
    }

    setGroupRemark(data, remark) {
      AgentRuntime.makeLog("info", `设置群备注：${remark}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_remark", {
        group_id: data.group_id,
        remark
      })
    }

    setGroupAddOption(data, option) {
      AgentRuntime.makeLog("info", `设置群添加选项：${option}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_add_option", {
        group_id: data.group_id,
        option
      })
    }

    setGroupBotAddOption(data, option) {
      AgentRuntime.makeLog("info", `设置群机器人添加选项：${option}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_bot_add_option", {
        group_id: data.group_id,
        option
      })
    }

    getGroupSystemMsg(data) {
      return data.bot.sendApi("get_group_system_msg", {
        group_id: data.group_id
      })
    }

    getGroupFilterSystemMsg(data) {
      return data.bot.sendApi("get_group_filter_system_msg", {
        group_id: data.group_id
      })
    }

    setGroupSearch(data, enable) {
      AgentRuntime.makeLog("info", `${enable ? '开启' : '关闭'}群搜索`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("set_group_search", {
        group_id: data.group_id,
        enable: Boolean(enable)
      })
    }

    /**
     * 发送群公告
     * @param {Object} data - 数据对象
     * @param {string} content - 公告内容（必需）
     * @param {string} image - 图片路径（可选）
     * @param {number|string} pinned - 是否置顶（可选）
     * @param {number|string} type - 公告类型（可选）
     * @param {number|string} confirm_required - 是否需要确认（可选）
     * @param {number|string} is_show_edit_card - 是否显示编辑卡片（可选）
     * @param {number|string} tip_window_type - 提示窗口类型（可选）
     * @returns {Promise}
     */
    sendGroupNotice(data, content, options = {}) {
      const { image, pinned, type, confirm_required, is_show_edit_card, tip_window_type } = options
      
      AgentRuntime.makeLog("info", `发送群公告：${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`, `${data.self_id} => ${data.group_id}`, true)
      
      const params = {
        group_id: data.group_id,
        content: String(content)
      }
      
      // 可选参数
      if (image !== undefined) params.image = String(image)
      if (pinned !== undefined) params.pinned = pinned
      if (type !== undefined) params.type = type
      if (confirm_required !== undefined) params.confirm_required = confirm_required
      if (is_show_edit_card !== undefined) params.is_show_edit_card = is_show_edit_card
      if (tip_window_type !== undefined) params.tip_window_type = tip_window_type
      
      return data.bot.sendApi("_send_group_notice", params)
    }

    /**
     * 获取群公告
     * @param {Object} data - 数据对象
     * @returns {Promise}
     */
    getGroupNotice(data) {
      AgentRuntime.makeLog("info", `获取群公告`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("_get_group_notice", {
        group_id: data.group_id
      })
    }

    /**
     * 删除群公告
     * @param {Object} data - 数据对象
     * @param {string} notice_id - 公告ID
     * @returns {Promise}
     */
    deleteGroupNotice(data, notice_id) {
      AgentRuntime.makeLog("info", `删除群公告：${notice_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("_delete_group_notice", {
        group_id: data.group_id,
        notice_id: String(notice_id)
      })
    }


    moveGroupFile(data, file_id, busid, folder_id) {
      AgentRuntime.makeLog("info", `移动群文件：${file_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("move_group_file", {
        group_id: data.group_id,
        file_id,
        busid,
        folder_id
      })
    }

    renameGroupFile(data, file_id, busid, name) {
      AgentRuntime.makeLog("info", `重命名群文件：${name}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("rename_group_file", {
        group_id: data.group_id,
        file_id,
        busid,
        name
      })
    }

    saveFileToCache(data, file_id, busid) {
      AgentRuntime.makeLog("info", `转存为永久文件：${file_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("save_file_to_cache", {
        group_id: data.group_id,
        file_id,
        busid
      })
    }

    downloadFileToCache(data, url, thread_count, headers) {
      return data.bot.sendApi("download_file_to_cache", {
        url,
        thread_count,
        headers
      })
    }

    clearCache(data) {
      AgentRuntime.makeLog("info", "清空缓存", data.self_id)
      return data.bot.sendApi("clear_cache", {})
    }

    deleteGroupFileFolder(data, folder_id) {
      AgentRuntime.makeLog("info", `删除群文件夹：${folder_id}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("delete_group_file_folder", {
        group_id: data.group_id,
        folder_id
      })
    }

    getPrivateFileUrl(data, file_id, busid) {
      return data.bot.sendApi("get_private_file_url", {
        user_id: data.user_id,
        file_id,
        busid
      })
    }

    getFileInfo(data, file_id, busid) {
      return data.bot.sendApi("get_file_info", {
        file_id,
        busid
      })
    }


    setMsgRead(data, message_id) {
      return data.bot.sendApi("set_msg_read", {
        message_id
      })
    }

    setPrivateMsgRead(data, user_id) {
      return data.bot.sendApi("set_private_msg_read", {
        user_id
      })
    }

    setGroupMsgRead(data, group_id) {
      return data.bot.sendApi("set_group_msg_read", {
        group_id
      })
    }

    getRecentContactList(data) {
      return data.bot.sendApi("get_recent_contact_list", {})
    }

    getUserStatus(data, user_id) {
      return data.bot.sendApi("get_user_status", {
        user_id
      })
    }

    getStatus(data) {
      return data.bot.sendApi("get_status", {})
    }

    setOnlineStatus(data, status) {
      AgentRuntime.makeLog("info", `设置在线状态：${status}`, data.self_id)
      return data.bot.sendApi("set_online_status", {
        status
      })
    }

    setCustomOnlineStatus(data, text, face) {
      AgentRuntime.makeLog("info", `设置自定义在线状态：${text}`, data.self_id)
      return data.bot.sendApi("set_custom_online_status", {
        text,
        face
      })
    }

    setFriendRemark(data, user_id, remark) {
      AgentRuntime.makeLog("info", `设置好友备注：${remark}`, `${data.self_id} => ${user_id}`, true)
      return data.bot.sendApi("set_friend_remark", {
        user_id,
        remark
      })
    }


    async ocrImage(data, image) {
      return data.bot.sendApi("ocr_image", {
        image: await this.makeFile(image),
      })
    }

    translateEnToZh(data, text) {
      return data.bot.sendApi("translate_en_to_zh", {
        text
      })
    }

    setInputStatus(data, user_id, typing) {
      return data.bot.sendApi("set_input_status", {
        user_id,
        typing: Boolean(typing)
      })
    }

    getAiVoicePerson(data) {
      return data.bot.sendApi("get_ai_voice_person", {})
    }

    getAiVoice(data, text, person) {
      return data.bot.sendApi("get_ai_voice", {
        text,
        person
      })
    }

    clickButton(data, button_id) {
      return data.bot.sendApi("click_button", {
        button_id
      })
    }


    getPacketStatus(data) {
      return data.bot.sendApi("get_packet_status", {})
    }

    sendCustomPacket(data, packet) {
      return data.bot.sendApi("send_custom_packet", {
        packet
      })
    }

    getBotAccountRange(data) {
      return data.bot.sendApi("get_bot_account_range", {})
    }

    logout(data) {
      AgentRuntime.makeLog("info", "账号退出", data.self_id)
      return data.bot.sendApi("logout", {})
    }

    /**
     * 创建好友对象
     */
    pickFriend(data, user_id) {
      const i = {
        ...data.bot.fl.get(user_id),
        ...data,
        user_id,
      }
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendFriendForwardMsg.bind(this, i),
        sendFile: this.sendFriendFile.bind(this, i),
        getInfo: this.getFriendInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
        getChatHistory: this.getFriendMsgHistory.bind(this, i),
        thumbUp: this.sendLike.bind(this, i),
        delete: this.deleteFriend.bind(this, i),
      }
    }

    /**
     * 创建成员对象
     */
    pickMember(data, group_id, user_id) {
      if (typeof group_id === "string" && group_id.match("-")) {
        const guild_id = group_id.split("-")
        const i = {
          ...data,
          guild_id: guild_id[0],
          channel_id: guild_id[1],
          user_id,
        }
        return {
          ...this.pickGroup(i, group_id),
          ...i,
          getInfo: this.getGuildMemberInfo.bind(this, i),
          getAvatarUrl: async () => (await this.getGuildMemberInfo(i)).avatar_url,
        }
      }

      const memberInfo = data.bot.gml?.get(group_id)?.get(user_id) || {}
      const i = {
        ...memberInfo,
        ...data,
        group_id,
        user_id,
      }

      return {
        ...this.pickFriend(i, user_id),
        ...i,
        getInfo: this.getMemberInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
        poke: () => this.sendPoke(i, user_id),
        mute: this.setGroupBan.bind(this, i, user_id),
        kick: this.setGroupKick.bind(this, i, user_id),
        get is_friend() {
          return data.bot.fl.has(user_id)
        },
        get is_owner() {
          return memberInfo.role === "owner"
        },
        get is_admin() {
          return memberInfo.role === "admin" || memberInfo.role === "owner"
        },
      }
    }

    /**
     * 创建群对象
     */
    pickGroup(data, group_id) {
      if (typeof group_id === "string" && group_id.match("-")) {
        const guild_id = group_id.split("-")
        const i = {
          ...data.bot.gl.get(group_id),
          ...data,
          guild_id: guild_id[0],
          channel_id: guild_id[1],
        }
        return {
          ...i,
          sendMsg: this.sendGuildMsg.bind(this, i),
          getMsg: this.getMsg.bind(this, i),
          recallMsg: this.recallMsg.bind(this, i),
          getForwardMsg: this.getForwardMsg.bind(this, i),
          getInfo: this.getGuildInfo.bind(this, i),
          getChannelArray: this.getGuildChannelArray.bind(this, i),
          getChannelList: this.getGuildChannelList.bind(this, i),
          getChannelMap: this.getGuildChannelMap.bind(this, i),
          getMemberArray: this.getGuildMemberArray.bind(this, i),
          getMemberList: this.getGuildMemberList.bind(this, i),
          getMemberMap: this.getGuildMemberMap.bind(this, i),
          pickMember: this.pickMember.bind(this, i),
        }
      }

      const i = {
        ...data.bot.gl.get(group_id),
        ...data,
        group_id,
      }

      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        getMsg: this.getMsg.bind(this, i),
        recallMsg: this.recallMsg.bind(this, i),
        getForwardMsg: this.getForwardMsg.bind(this, i),
        sendForwardMsg: this.sendGroupForwardMsg.bind(this, i),
        sendFile: (file, name) => this.sendGroupFile(i, file, undefined, name),
        getInfo: this.getGroupInfo.bind(this, i),
        getAvatarUrl() {
          return this.avatar || `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
        },
        getChatHistory: this.getGroupMsgHistory.bind(this, i),
        getHonorInfo: this.getGroupHonorInfo.bind(this, i),
        getEssence: this.getEssenceMsg.bind(this, i),
        setEssenceMessage: this.setEssenceMsg.bind(this, i),
        removeEssenceMessage: this.deleteEssenceMsg.bind(this, i),
        setEmojiLike: (message_id, emoji_id, set = true) => this.setEmojiLike(i, message_id, emoji_id, set),
        getMemberArray: this.getMemberArray.bind(this, i),
        getMemberList: this.getMemberList.bind(this, i),
        getMemberMap: this.getMemberMap.bind(this, i),
        pickMember: this.pickMember.bind(this, i, group_id),
        pokeMember: qq => this.sendPoke(i, qq),
        setName: this.setGroupName.bind(this, i),
        setAvatar: this.setGroupAvatar.bind(this, i),
        setAdmin: this.setGroupAdmin.bind(this, i),
        setCard: this.setGroupCard.bind(this, i),
        setTitle: this.setGroupTitle.bind(this, i),
        sign: this.sendGroupSign.bind(this, i),
        muteMember: this.setGroupBan.bind(this, i),
        muteAll: this.setGroupWholeKick.bind(this, i),
        kickMember: this.setGroupKick.bind(this, i),
        kickMembers: this.setGroupKickMembers.bind(this, i),
        quit: this.setGroupLeave.bind(this, i),
        getInfoEx: this.getGroupInfoEx.bind(this, i),
        getAtAllRemain: this.getGroupAtAllRemain.bind(this, i),
        getBanList: this.getGroupBanList.bind(this, i),
        setTodo: this.setGroupTodo.bind(this, i),
        setRemark: this.setGroupRemark.bind(this, i),
        setAddOption: this.setGroupAddOption.bind(this, i),
        setBotAddOption: this.setGroupBotAddOption.bind(this, i),
        getSystemMsg: this.getGroupSystemMsg.bind(this, i),
        getFilterSystemMsg: this.getGroupFilterSystemMsg.bind(this, i),
        setSearch: this.setGroupSearch.bind(this, i),
        sendNotice: (content, options) => this.sendGroupNotice(i, content, options),
        getNotice: this.getGroupNotice.bind(this, i),
        deleteNotice: notice_id => this.deleteGroupNotice(i, notice_id),
        fs: this.getGroupFs(i),
        get is_owner() {
          const botMemberInfo = data.bot.gml?.get(group_id)?.get(data.self_id)
          return botMemberInfo?.role === "owner"
        },
        get is_admin() {
          const botMemberInfo = data.bot.gml?.get(group_id)?.get(data.self_id)
          return botMemberInfo?.role === "admin" || botMemberInfo?.role === "owner"
        },
      }
    }

    /**
     * 建立连接时初始化AgentRuntime实例
     * 关键优化：先初始化基础信息并立即触发connect事件，耗时操作异步执行
     */
    async connect(data, ws) {
      const self_id = data.self_id != null ? String(data.self_id) : data.self_id
      
      // 初始化AgentRuntime基础结构（保留OneBot特定功能）
      AgentRuntime[self_id] = {
        tasker: this,
        ws: ws,
        sendApi: this.sendApi.bind(this, data, ws),
        stat: {
          start_time: data.time,
          stat: {},
          get lost_pkt_cnt() {
            return this.stat.packet_lost
          },
          get lost_times() {
            return this.stat.lost_times
          },
          get recv_msg_cnt() {
            return this.stat.message_received
          },
          get recv_pkt_cnt() {
            return this.stat.packet_received
          },
          get sent_msg_cnt() {
            return this.stat.message_sent
          },
          get sent_pkt_cnt() {
            return this.stat.packet_sent
          },
        },
        model: "XRK-AGT",

        info: {},
        get uin() {
          return this.info.user_id
        },
        get nickname() {
          return this.info.nickname
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
        },

        setProfile: this.setProfile.bind(this, data),
        setNickname: nickname => this.setProfile(data, { nickname }),
        setAvatar: this.setAvatar.bind(this, data),

        pickFriend: this.pickFriend.bind(this, data),
        get pickUser() {
          return this.pickFriend
        },
        getFriendArray: this.getFriendArray.bind(this, data),
        getFriendList: this.getFriendList.bind(this, data),
        getFriendMap: this.getFriendMap.bind(this, data),
        fl: new Map(),

        // 便捷发送方法，供路由/插件直接调用
        sendFriendMsg: (user_id, msg, extra = {}) =>
          this.sendFriendMsg({ ...data, ...extra, self_id, user_id, bot: AgentRuntime[self_id] }, msg),
        sendGroupMsg: (group_id, msg, extra = {}) =>
          this.sendGroupMsg({ ...data, ...extra, self_id, group_id, bot: AgentRuntime[self_id] }, msg),
        sendMsg: (params, msg) => {
          if (params?.group_id) return this.sendGroupMsg({ ...data, ...params, bot: AgentRuntime[self_id] }, msg)
          if (params?.user_id) return this.sendFriendMsg({ ...data, ...params, bot: AgentRuntime[self_id] }, msg)
          return Promise.reject(AgentRuntime.makeError("发送失败：缺少 user_id 或 group_id", params))
        },
        sendFriendForwardMsg: (user_id, messages, extra = {}) =>
          this.sendFriendForwardMsg({ ...data, ...extra, self_id, user_id, bot: AgentRuntime[self_id] }, messages),
        sendGroupForwardMsg: (group_id, messages, extra = {}) =>
          this.sendGroupForwardMsg({ ...data, ...extra, self_id, group_id, bot: AgentRuntime[self_id] }, messages),
        sendForwardMsg: (params, messages) => {
          if (params?.group_id)
            return this.sendGroupForwardMsg({ ...data, ...params, bot: AgentRuntime[self_id] }, messages)
          if (params?.user_id)
            return this.sendFriendForwardMsg({ ...data, ...params, bot: AgentRuntime[self_id] }, messages)
          return Promise.reject(AgentRuntime.makeError("发送转发消息失败：缺少 user_id 或 group_id", params))
        },

        pickMember: this.pickMember.bind(this, data),
        pickGroup: this.pickGroup.bind(this, data),
        getGroupArray: this.getGroupArray.bind(this, data),
        getGroupList: this.getGroupList.bind(this, data),
        getGroupMap: this.getGroupMap.bind(this, data),
        getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
        gl: new Map(),
        gml: new Map(),

        request_list: [],
        getSystemMsg() {
          return this.request_list
        },
        setFriendAddRequest: this.setFriendAddRequest.bind(this, data),
        setGroupAddRequest: this.setGroupAddRequest.bind(this, data),

        setEssenceMessage: this.setEssenceMsg.bind(this, data),
        removeEssenceMessage: this.deleteEssenceMsg.bind(this, data),

        // 新增 API 方法
        setMsgRead: this.setMsgRead.bind(this, data),
        setPrivateMsgRead: this.setPrivateMsgRead.bind(this, data),
        setGroupMsgRead: this.setGroupMsgRead.bind(this, data),
        getRecentContactList: this.getRecentContactList.bind(this, data),
        getUserStatus: this.getUserStatus.bind(this, data),
        getStatus: this.getStatus.bind(this, data),
        setOnlineStatus: this.setOnlineStatus.bind(this, data),
        setCustomOnlineStatus: this.setCustomOnlineStatus.bind(this, data),
        setFriendRemark: this.setFriendRemark.bind(this, data),
        ocrImage: this.ocrImage.bind(this, data),
        translateEnToZh: this.translateEnToZh.bind(this, data),
        setInputStatus: this.setInputStatus.bind(this, data),
        getAiVoicePerson: this.getAiVoicePerson.bind(this, data),
        getAiVoice: this.getAiVoice.bind(this, data),
        clickButton: this.clickButton.bind(this, data),
        getPacketStatus: this.getPacketStatus.bind(this, data),
        sendCustomPacket: this.sendCustomPacket.bind(this, data),
        getBotAccountRange: this.getBotAccountRange.bind(this, data),
        logout: this.logout.bind(this, data),
        downloadFileToCache: this.downloadFileToCache.bind(this, data),
        clearCache: this.clearCache.bind(this, data),
        getPrivateFileUrl: this.getPrivateFileUrl.bind(this, data),
        getFileInfo: this.getFileInfo.bind(this, data),

        cookies: {},
        getCookies(domain) {
          return this.cookies[domain]
        },
        getCsrfToken() {
          return this.bkn
        },
        
        _ready: false,
        _initializing: false
      }
      
      data.bot = AgentRuntime[self_id]

      if (!AgentRuntime.uin.includes(self_id)) AgentRuntime.uin.push(self_id)

      try {
        await data.bot.sendApi("_set_model_show", {
          model: data.bot.model,
          model_show: data.bot.model,
        })
      } catch {
        // 忽略模型显示设置失败
      }

      try {
        const loginInfo = await data.bot.sendApi("get_login_info")
        data.bot.info = loginInfo?.data || {}
      } catch (err) {
        AgentRuntime.makeLog("warn", `获取登录信息失败: ${err.message}`, self_id)
        data.bot.info = {}
      }

      try {
        const versionInfo = await data.bot.sendApi("get_version_info")
        data.bot.version = {
          ...(versionInfo?.data || {}),
          id: this.id,
          name: this.name,
          get version() {
            return this.app_full_name || `${this.app_name} v${this.app_version}`
          },
        }
      } catch (err) {
        AgentRuntime.makeLog("warn", `获取版本信息失败: ${err.message}`, self_id)
        data.bot.version = {
          id: this.id,
          name: this.name,
          get version() {
            return `${this.name} unknown`
          },
        }
      }

      AgentRuntime.makeLog("mark", `${this.name}(${this.id}) ${data.bot.version.version} 已连接`, self_id)
      AgentRuntime.em(`connect.${self_id}`, data)
      
      data.bot._initializing = true
      setImmediate(async () => {
        try {
          try {
            const guildProfile = await data.bot.sendApi("get_guild_service_profile")
            data.bot.guild_info = guildProfile?.data
          } catch (err) {
            AgentRuntime.makeLog("debug", `获取频道资料失败: ${err.message}`, self_id)
          }

          try {
            const clients = await data.bot.sendApi("get_online_clients")
            data.bot.clients = clients?.clients
          } catch (err) {
            AgentRuntime.makeLog("debug", `获取在线客户端失败: ${err.message}`, self_id)
          }

          // 获取cookies
          try {
            const qunCookies = await data.bot.sendApi("get_cookies", { domain: "qun.qq.com" })
            if (qunCookies?.cookies) {
              data.bot.cookies["qun.qq.com"] = qunCookies.cookies
              
              const domains = [
                "aq", "connect", "docs", "game", "gamecenter", "haoma", "id", "kg", 
                "mail", "mma", "office", "openmobile", "qqweb", "qzone", "ti", "v", "vip", "y",
              ]
              
              for (const domainPrefix of domains) {
                const domain = `${domainPrefix}.qq.com`
                try {
                  const result = await data.bot.sendApi("get_cookies", { domain })
                  if (result?.cookies) {
                    data.bot.cookies[domain] = result.cookies
                  }
                } catch (err) {
                  AgentRuntime.makeLog("debug", `获取 ${domain} cookies 失败: ${err.message}`, self_id)
                }
              }
            }
          } catch (err) {
            AgentRuntime.makeLog("warn", `获取cookies失败: ${err.message}`, self_id)
          }

          try {
            const csrfToken = await data.bot.sendApi("get_csrf_token")
            data.bot.bkn = csrfToken?.token
          } catch (err) {
            AgentRuntime.makeLog("debug", `获取CSRF token失败: ${err.message}`, self_id)
          }

          // 加载好友列表
          try {
            await data.bot.getFriendMap()
            AgentRuntime.makeLog("debug", `好友列表加载完成`, self_id)
          } catch (err) {
            AgentRuntime.makeLog("warn", `获取好友列表失败: ${err.message}`, self_id)
            if (!(data.bot.fl instanceof Map)) {
              data.bot.fl = new Map()
            }
          }

          // 加载群和群成员列表
          try {
            await data.bot.getGroupMemberMap()
            AgentRuntime.makeLog("debug", `群列表和成员列表加载完成`, self_id)
          } catch (err) {
            AgentRuntime.makeLog("warn", `获取群成员列表失败: ${err.message}`, self_id)
            if (!(data.bot.gml instanceof Map)) {
              data.bot.gml = new Map()
            }
          }

          data.bot._ready = true
          data.bot._initializing = false
          AgentRuntime.em(`ready.${self_id}`, data)
          AgentRuntime.em('ready', { ...data, self_id: self_id, uin: self_id })
          
        } catch (err) {
          AgentRuntime.makeLog("error", `后台数据加载失败: ${err.message}`, self_id)
          data.bot._ready = true
          data.bot._initializing = false
        }
      })
    }

    /**
     * 标准化消息数据字段
     * @param {Object} data - 消息数据对象
     * @returns {boolean} 是否成功标准化
     */
    normalizeMessageData(data) {
      // 基础字段检查
      data.post_type = data.post_type || 'message'
      data.bot = data.bot || (data.self_id ? AgentRuntime[data.self_id] : null)
      
      if (!data.bot) {
        AgentRuntime.makeLog("warn", `AgentRuntime对象不存在，忽略消息：${data.self_id}`, data.self_id)
        return false
      }
      
      // 时间戳和事件ID
      data.time = data.time || Math.floor(Date.now() / 1000)
      if (!data.event_id) {
        // message_id 本身就是同一条消息的稳定标识；拼接 time 会导致重复上报时产生不同 event_id，去重失效
        const idPart = data.message_id ? String(data.message_id) : `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        data.event_id = `onebot_${data.self_id}_${idPart}`
      }
      
      // 消息类型推断
      data.message_type = data.message_type || (data.group_id ? 'group' : 'private')
      data.sub_type = data.sub_type || (data.message_type === 'group' ? 'normal' : 'friend')
      
      // 解析消息数组
      data.message = data.message ? this.parseMsg(data.message) : []
      
      // 生成 raw_message
      if (!data.raw_message && data.message.length > 0) {
        data.raw_message = data.message
          .map(seg => this.messageSegmentToCQ(seg))
          .join('')
      }
      data.raw_message = data.raw_message || ''
      data.msg = data.raw_message
      
      // 标志设置
      data.isGroup = data.message_type === 'group'
      data.isPrivate = data.message_type === 'private'
      
      // Sender 对象标准化
      data.sender = data.sender || {}
      data.sender.user_id = data.sender.user_id || data.user_id
      
      // 事件访问器、回复兜底、获取被回复消息（方便插件处理媒体等）
      this.attachRelationAccessors(data)
      this.attachReplyMethod(data)
      this.attachGetReply(data)

      // tasker 短名（事件身份；bot.tasker 仍可为实例）
      data.tasker = 'onebot'
      data.isOneBot = true
      
      return true
    }

    /**
     * 将消息段转换为 CQ 码字符串
     * @param {Object} seg - 消息段对象
     * @returns {string} CQ 码字符串
     */
    messageSegmentToCQ(seg) {
      const typeMap = {
        text: () => seg.text || '',
        at: () => `[CQ:at,qq=${seg.qq || seg.user_id || ''}]`,
        image: () => `[CQ:image,file=${seg.url || seg.file || ''}]`,
        face: () => `[CQ:face,id=${seg.id || ''}]`,
        reply: () => `[CQ:reply,id=${seg.id || ''}]`,
        record: () => `[CQ:record,file=${seg.file || ''}]`,
        video: () => `[CQ:video,file=${seg.file || ''}]`,
        file: () => `[CQ:file,file=${seg.file || ''}]`
      }
      return typeMap[seg.type] ? typeMap[seg.type]() : `[${seg.type}]`
    }

    /**
     * 为事件对象添加属性访问器
     * @param {Object} data - 事件数据对象
     * @param {string} prop - 属性名 (friend/group/member)
     * @param {Function} getter - 获取器函数
     */
    defineEventProperty(data, prop, getter) {
      Object.defineProperty(data, prop, {
        get: getter,
        configurable: true,
        enumerable: false
      })
    }

    /**
     * 为事件对象挂载 friend / group / member 等访问器及聊天记录方法
     */
    attachRelationAccessors(data) {
      if (!data.bot) return

      const hasOwn = prop => Object.hasOwn(data, prop)

      if (data.user_id && !hasOwn("friend") && typeof data.bot.pickFriend === "function") {
        this.defineEventProperty(data, "friend", () => data.bot.pickFriend(data.user_id))
      }

      if (data.group_id && !hasOwn("group") && typeof data.bot.pickGroup === "function") {
        this.defineEventProperty(data, "group", () => data.bot.pickGroup(data.group_id))
        if (!data.group_name) {
          data.group_name = data.bot.gl?.get?.(data.group_id)?.group_name || data.group_name
        }
      }

      if (data.group_id && data.user_id && !hasOwn("member") && typeof data.bot.pickMember === "function") {
        this.defineEventProperty(data, "member", () => data.bot.pickMember(data.group_id, data.user_id))
      }

      // 尝试补全 sender 信息，便于插件使用
      const memberInfo = data.bot.gml?.get?.(data.group_id)?.get?.(data.user_id)
      const friendInfo = data.bot.fl?.get?.(data.user_id)
      if (memberInfo) {
        data.sender.nickname ||= memberInfo.nickname || memberInfo.card
        data.sender.card ||= memberInfo.card
      }
      if (!data.sender.nickname && friendInfo?.nickname) {
        data.sender.nickname = friendInfo.nickname
      }

      // 聊天记录快捷方法（群/私聊）
      if (data.message_type === "group" && data.group_id && !data.getChatHistory) {
        const ctx = { ...data, bot: data.bot, group_id: data.group_id }
        data.getChatHistory = this.getGroupMsgHistory.bind(this, ctx)
      } else if (data.message_type === "private" && data.user_id && !data.getChatHistory) {
        const ctx = { ...data, bot: data.bot, user_id: data.user_id }
        data.getChatHistory = this.getFriendMsgHistory.bind(this, ctx)
      }
    }

    /**
     * 为事件对象挂载 reply 方法（兜底）
     */
    attachReplyMethod(data) {
      if (typeof data.reply === "function") return
      if (!data.bot) return

      const fromGroup = () => {
        if (data.group?.sendMsg) return msg => data.group.sendMsg(msg)
        if (data.group_id && data.bot.tasker?.sendGroupMsg)
          return msg => data.bot.tasker.sendGroupMsg({ ...data, group_id: data.group_id }, msg)
        return null
      }

      const fromFriend = () => {
        if (data.friend?.sendMsg) return msg => data.friend.sendMsg(msg)
        if (data.user_id && data.bot.tasker?.sendFriendMsg)
          return msg => data.bot.tasker.sendFriendMsg({ ...data, user_id: data.user_id }, msg)
        return null
      }

      data.reply = fromGroup() || fromFriend() || data.reply
    }

    /**
     * 挂载 getReply：获取当前消息所回复的那条消息（含完整内容/媒体），便于插件处理
     * @returns {Promise<{ id, message_id, sender?, message?, raw_message?, time? }|null>}
     */
    attachGetReply(data) {
      if (typeof data.getReply === "function") return
      data.getReply = async () => {
        const seg = data.message?.find(s => s && s.type === "reply")
        const id = seg?.id ?? seg?.data?.id
        if (id == null) return null
        const numId = Number(id)
        const getter = data.group?.getMsg ?? data.friend?.getMsg
        if (!getter) return { id: numId, message_id: numId, raw_message: "", message: [] }
        try {
          const msg = await getter(numId)
          return {
            id: msg.message_id ?? numId,
            message_id: msg.message_id,
            sender: msg.sender,
            message: msg.message || [],
            raw_message: msg.raw_message ?? "",
            time: msg.time
          }
        } catch (e) {
          return { id: numId, message_id: numId, raw_message: "", message: [] }
        }
      }
    }

    /**
     * 处理私聊消息
     * @param {Object} data - 消息数据对象
     */
    handlePrivateMessage(data) {
      const name = data.sender?.card || 
                   data.sender?.nickname || 
                   data.bot?.fl?.get?.(data.user_id)?.nickname ||
                   data.user_id
      
      AgentRuntime.makeLog(
        "info",
        `好友消息：${name ? `[${name}] ` : ""}${data.raw_message}`,
        `${data.self_id} <= ${data.user_id}`,
        true
      )
    }

    /**
     * 处理群聊消息
     * @param {Object} data - 消息数据对象
     */
    handleGroupMessage(data) {
      const group_name = data.group_name || data.bot?.gl?.get?.(data.group_id)?.group_name
      let user_name = data.sender?.card || data.sender?.nickname
      
      if (!user_name && data.bot) {
        const user = data.bot.gml?.get?.(data.group_id)?.get?.(data.user_id) || 
                     data.bot.fl?.get?.(data.user_id)
        user_name = user?.card || user?.nickname
      }
      
      AgentRuntime.makeLog(
        "info",
        `群消息：${user_name ? `[${group_name ? `${group_name}, ` : ""}${user_name}] ` : ""}${data.raw_message}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true
      )
    }

    /**
     * 处理频道消息
     * @param {Object} data - 消息数据对象
     */
    handleGuildMessage(data) {
      data.message_type = "group"
      data.group_id = `${data.guild_id}-${data.channel_id}`
      
      AgentRuntime.makeLog(
        "info",
        `频道消息：[${data.sender?.nickname || ''}] ${AgentRuntime.String(data.message)}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true
      )
    }

    /**
     * 处理消息事件
     * @param {Object} data - 消息数据对象
     * @returns {boolean} 是否成功处理
     */
    makeMessage(data) {
      // 标准化消息数据
      if (!this.normalizeMessageData(data)) {
        return false
      }

      // 按需展开合并转发（插件可 await e.expandForward()）
      data.expandForward = async (depth = 0) => {
        if (!Array.isArray(data.message)) return []
        data.message = await this.expandForwardSegments(data, data.message, depth)
        return data.message
      }
      
      // 根据消息类型处理
      const handlers = {
        private: () => this.handlePrivateMessage(data),
        group: () => this.handleGroupMessage(data),
        guild: () => this.handleGuildMessage(data)
      }
      
      const handler = handlers[data.message_type]
      if (handler) {
        handler()
      } else {
        AgentRuntime.makeLog("warn", `未知消息类型：${data.message_type}，原始数据：${AgentRuntime.String(data.raw || data)}`, data.self_id)
      }
      
      // 触发事件
      const onebotEvent = `onebot.${data.post_type}`
      try {
        AgentRuntime.em(onebotEvent, data)
        return true
      } catch (err) {
        AgentRuntime.makeLog("error", `触发事件失败：${err.message}`, data.self_id, err)
        return false
      }
    }

    /**
     * 处理通知事件
     */
    async makeNotice(data) {
      switch (data.notice_type) {
        case "friend_recall":
          AgentRuntime.makeLog(
            "info",
            `好友消息撤回：${data.message_id}`,
            `${data.self_id} <= ${data.user_id}`,
            true,
          )
          break
        case "group_recall":
          AgentRuntime.makeLog(
            "info",
            `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
            `${data.self_id} <= ${data.group_id}`,
            true,
          )
          break
        case "group_increase": {
          AgentRuntime.makeLog(
            "info",
            `群成员增加：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}`,
            true,
          )
          const group = data.bot.pickGroup(data.group_id)
          group.getInfo()
          // 新成员加入时更新成员列表
          group.pickMember(data.user_id).getInfo()
          break
        }
        case "group_decrease": {
          AgentRuntime.makeLog(
            "info",
            `群成员减少：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}`,
            true,
          )
          if (data.user_id === data.self_id) {
            data.bot.gl.delete(data.group_id)
            data.bot.gml.delete(data.group_id)
          } else {
            data.bot.pickGroup(data.group_id).getInfo()
            data.bot.gml?.get(data.group_id)?.delete(data.user_id)
          }
          break
        }
        case "group_admin":
          AgentRuntime.makeLog(
            "info",
            `群管理员变动：${data.sub_type}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true,
          )
          data.set = data.sub_type === "set"
          data.bot.pickMember(data.group_id, data.user_id).getInfo()
          break
        case "group_upload":
          AgentRuntime.makeLog(
            "info",
            `群文件上传：${AgentRuntime.String(data.file)}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true,
          )
          const fileEventData = {
            ...data,
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            message: [{ ...data.file, type: "file" }],
            raw_message: `[文件：${data.file.name}]`,
          }
          AgentRuntime.em("onebot.message", fileEventData)
          break
        case "group_ban":
          AgentRuntime.makeLog(
            "info",
            `群禁言：${data.operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`,
            `${data.self_id} <= ${data.group_id}`,
            true,
          )
          data.bot.pickMember(data.group_id, data.user_id).getInfo()
          break
        case "group_msg_emoji_like":
          AgentRuntime.makeLog(
            "info",
            [`群消息回应：${data.message_id}`, data.likes],
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true,
          )
          break
        case "friend_add":
          AgentRuntime.makeLog("info", "好友添加", `${data.self_id} <= ${data.user_id}`, true)
          data.bot.pickFriend(data.user_id).getInfo()
          break
        case "notify":
          if (data.group_id) data.notice_type = "group"
          else data.notice_type = "friend"
          data.user_id ??= data.operator_id || data.target_id
          switch (data.sub_type) {
            case "poke":
              data.operator_id = data.user_id
              if (data.group_id)
                AgentRuntime.makeLog(
                  "info",
                  `群戳一戳：${data.operator_id} => ${data.target_id}`,
                  `${data.self_id} <= ${data.group_id}`,
                  true,
                )
              else
                AgentRuntime.makeLog(
                  "info",
                  `好友戳一戳：${data.operator_id} => ${data.target_id}`,
                  data.self_id,
                )
              break
            case "honor":
              AgentRuntime.makeLog(
                "info",
                `群荣誉：${data.honor_type}`,
                `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
                true,
              )
              data.bot.pickMember(data.group_id, data.user_id).getInfo()
              break
            case "title":
              AgentRuntime.makeLog(
                "info",
                `群头衔：${data.title}`,
                `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
                true,
              )
              data.bot.pickMember(data.group_id, data.user_id).getInfo()
              break
            case "group_name":
              AgentRuntime.makeLog(
                "info",
                `群名更改：${data.name_new}`,
                `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
                true,
              )
              data.bot.pickGroup(data.group_id).getInfo()
              break
            case "input_status":
              data.post_type = "internal"
              data.notice_type = "input"
              data.end ??= data.event_type !== 1
              data.message ||= data.status_text || `对方${data.end ? "结束" : "正在"}输入...`
              AgentRuntime.makeLog("info", data.message, `${data.self_id} <= ${data.user_id}`, true)
              break
            case "profile_like":
              AgentRuntime.makeLog(
                "info",
                `资料卡点赞：${data.times}次`,
                `${data.self_id} <= ${data.operator_id}`,
                true,
              )
              break
            default:
              AgentRuntime.makeLog("warn", `未知通知：${AgentRuntime.String(data.raw || data)}`, data.self_id)
          }
          break
        case "group_card":
          AgentRuntime.makeLog(
            "info",
            `群名片更新：${data.card_old} => ${data.card_new}`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true,
          )
          data.bot.pickMember(data.group_id, data.user_id).getInfo()
          break
        case "offline_file":
          AgentRuntime.makeLog(
            "info",
            `离线文件：${AgentRuntime.String(data.file)}`,
            `${data.self_id} <= ${data.user_id}`,
            true,
          )
          const offlineFileEventData = {
            ...data,
            post_type: "message",
            message_type: "private",
            sub_type: "friend",
            message: [{ ...data.file, type: "file" }],
            raw_message: `[文件：${data.file.name}]`,
          }
          AgentRuntime.em("onebot.message", offlineFileEventData)
          break
        case "client_status":
          AgentRuntime.makeLog(
            "info",
            `客户端${data.online ? "上线" : "下线"}：${AgentRuntime.String(data.client)}`,
            data.self_id,
          )
          data.clients = (await data.bot.sendApi("get_online_clients")).clients
          data.bot.clients = data.clients
          break
        case "essence":
          data.notice_type = "group_essence"
          AgentRuntime.makeLog(
            "info",
            `群精华消息：${data.operator_id} => ${data.sender_id} ${data.sub_type} ${data.message_id}`,
            `${data.self_id} <= ${data.group_id}`,
            true,
          )
          break
        case "guild_channel_recall":
          AgentRuntime.makeLog(
            "info",
            `频道消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
            `${data.self_id} <= ${data.guild_id}-${data.channel_id}`,
            true,
          )
          break
        case "message_reactions_updated":
          data.notice_type = "guild_message_reactions_updated"
          AgentRuntime.makeLog(
            "info",
            `频道消息表情贴：${data.message_id} ${AgentRuntime.String(data.current_reactions)}`,
            `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
            true,
          )
          break
        case "channel_updated":
          data.notice_type = "guild_channel_updated"
          AgentRuntime.makeLog(
            "info",
            `子频道更新：${AgentRuntime.String(data.old_info)} => ${AgentRuntime.String(data.new_info)}`,
            `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
            true,
          )
          break
        case "channel_created":
          data.notice_type = "guild_channel_created"
          AgentRuntime.makeLog(
            "info",
            `子频道创建：${AgentRuntime.String(data.channel_info)}`,
            `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
            true,
          )
          data.bot.getGroupMap()
          break
        case "channel_destroyed":
          data.notice_type = "guild_channel_destroyed"
          AgentRuntime.makeLog(
            "info",
            `子频道删除：${AgentRuntime.String(data.channel_info)}`,
            `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
            true,
          )
          data.bot.getGroupMap()
          break
        case "bot_offline":
          data.post_type = "system"
          data.notice_type = "offline"
          AgentRuntime.makeLog("info", `${data.tag || "账号下线"}：${data.message}`, data.self_id)
          AgentRuntime.sendMasterMsg(`[${data.self_id}] ${data.tag || "账号下线"}：${data.message}`)
          break
        default:
          AgentRuntime.makeLog("warn", `未知通知：${AgentRuntime.String(data.raw || data)}`, data.self_id)
      }

      let notice = data.notice_type.split("_")
      data.notice_type = notice.shift()
      notice = notice.join("_")
      if (notice) data.sub_type = notice

      if (data.guild_id && data.channel_id) {
        data.group_id = `${data.guild_id}-${data.channel_id}`
        Object.defineProperty(data, "friend", {
          get() {
            return this.member || {}
          },
        })
      }

      data.tasker = 'onebot'
      data.isOneBot = true
      
      const onebotNoticeEvent = `onebot.${data.post_type}`
      AgentRuntime.em(onebotNoticeEvent, data)
    }

    /**
     * 处理请求事件
     */
    makeRequest(data) {
      switch (data.request_type) {
        case "friend":
          AgentRuntime.makeLog(
            "info",
            `加好友请求：${data.comment}(${data.flag})`,
            `${data.self_id} <= ${data.user_id}`,
            true,
          )
          data.sub_type = "add"
          data.approve = function (approve, remark) {
            return this.bot.setFriendAddRequest(this.flag, approve, remark)
          }
          break
        case "group":
          AgentRuntime.makeLog(
            "info",
            `加群请求：${data.sub_type} ${data.comment}(${data.flag})`,
            `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
            true,
          )
          data.approve = function (approve, reason) {
            return this.bot.setGroupAddRequest(this.flag, approve, reason, this.sub_type)
          }
          break
        default:
          AgentRuntime.makeLog("warn", `未知请求：${AgentRuntime.String(data.raw || data)}`, data.self_id)
      }

      data.bot.request_list.push(data)
      data.tasker = 'onebot'
      data.isOneBot = true
      
      const onebotRequestEvent = `onebot.${data.post_type}`
      AgentRuntime.em(onebotRequestEvent, data)
    }

    /**
     * 处理心跳
     */
    heartbeat(data) {
      if (data.status) Object.assign(data.bot.stat, data.status)
    }

    /**
     * 处理元事件
     */
    makeMeta(data, ws) {
      switch (data.meta_event_type) {
        case "heartbeat":
          this.heartbeat(data)
          break
        case "lifecycle":
          this.connect(data, ws)
          break
        default:
          AgentRuntime.makeLog("warn", `未知消息：${AgentRuntime.String(data.raw || data)}`, data.self_id)
      }
    }

    /**
     * WebSocket消息处理入口
     */
    message(data, ws) {
      try {
        data = {
          ...JSON.parse(data),
          raw: AgentRuntime.String(data),
        }
      } catch (err) {
        return AgentRuntime.makeLog("error", ["解码数据失败", data, err])
      }

      if (data.post_type) {
        if (data.meta_event_type !== "lifecycle" && !AgentRuntime.uin.includes(data.self_id)) {
          AgentRuntime.makeLog("warn", `找不到对应AgentRuntime，忽略消息：${AgentRuntime.String(data.raw || data)}`, data.self_id)
          return false
        }
        data.bot = AgentRuntime[data.self_id]

        switch (data.post_type) {
          case "meta_event":
            return this.makeMeta(data, ws)
          case "message":
            return this.makeMessage(data)
          case "notice":
            return this.makeNotice(data)
          case "request":
            return this.makeRequest(data)
          case "message_sent":
            try {
              AgentRuntime.em("onebot.message_sent", data)
            } catch {
            }
            return true
        }
      } else if (data.echo) {
        const cache = this.echo.get(data.echo)
        if (cache) return cache.resolve(data)
      }
      AgentRuntime.makeLog("warn", `未知消息：${AgentRuntime.String(data.raw || data)}`, data.self_id)
    }

    /**
     * 加载适配器
     */
    load() {
      if (!Array.isArray(AgentRuntime.wsf[this.path])) AgentRuntime.wsf[this.path] = []
      AgentRuntime.wsf[this.path].push((ws, ...args) =>
        ws.on("message", data => this.message(data, ws, ...args)),
      )
    }
  })(),
)