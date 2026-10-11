(globalThis as any).AgentRuntime.tasker.push(
  new (class OPQBotTasker {
  [key: string]: any;
    id = "QQ"
    name = "OPQBot"
    path = this.name
    echo = new Map()
    timeout = 60000
    CommandId: any = {
      FriendImage: 1,
      GroupImage: 2,
      FriendVoice: 26,
      GroupVoice: 29,
    }

    sendApi(id: any, CgiCmd: any, CgiRequest: any) {
      const ReqId = Math.round(Math.random() * 10 ** 16)
      const request: any = { BotUin: String(id), CgiCmd, CgiRequest, ReqId };
      (globalThis as any).AgentRuntime[id].ws.sendMsg(request)
      const cache = Promise.withResolvers()
      this.echo.set(ReqId, cache)
      const timeout = setTimeout(() => {
        cache.reject((globalThis as any).AgentRuntime.makeError("请求超时", request, { timeout: this.timeout }));
        (globalThis as any).AgentRuntime.makeLog("error", ["请求超时", request], id);
        (globalThis as any).AgentRuntime[id].ws.terminate()
      }, this.timeout)

      return cache.promise
        .then((data: any) => {
          if (data.CgiBaseResponse?.Ret !== 0)
            throw (globalThis as any).AgentRuntime.makeError(data.CgiBaseResponse?.ErrMsg, request, { error: data })
          return data
        })
        .finally(() => {
          clearTimeout(timeout)
          this.echo.delete(ReqId)
        })
    }

    makeLog(msg: any) {
      return (globalThis as any).AgentRuntime.String(msg).replace(/base64:\/\/.*?"/g, 'base64://..."')
    }

    async uploadFile(id: any, type: any, file: any) {
      const opts: any = { CommandId: this.CommandId[type] }

      file = await (globalThis as any).AgentRuntime.Buffer(file, {
        http: true,
        size: 10485760,
      })
      if (Buffer.isBuffer(file)) opts.Base64Buf = (file as any).toBase64()
      else if (file.match(/^https?:\/\//)) opts.FileUrl = file
      else opts.FilePath = file

      return (await this.sendApi(id, "PicUp.DataUp", opts)).ResponseData
    }

    async sendMsg(send: any, upload: any, msg: any) {
      if (!Array.isArray(msg)) msg = [msg]
      const message: any = {
        Content: "",
        Images: [] as any[],
        AtUinLists: [] as any[],
      }

      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", text: i }

        switch (i.type) {
          case "text":
            message.Content += i.text
            break
          case "image":
            message.Images.push(await upload("Image", i.file))
            break
          case "record":
            message.Voice = await upload("Voice", i.file)
            break
          case "at":
            message.AtUinLists.push({ Uin: i.qq })
            break
          case "video":
          case "file":
          case "face":
          case "reply":
          case "button":
            continue
          case "node":
            await (globalThis as any).AgentRuntime.sendForwardMsg((msg: any) => this.sendMsg(send, upload, msg), i.data)
            continue
          case "raw":
            for (const k in i.data) message[k] = i.data[k]
            continue
          default:
            message.Content += (globalThis as any).AgentRuntime.String(i)
        }
      }

      return send(message)
    }

    sendFriendMsg(data: any, msg: any) {
      (globalThis as any).AgentRuntime.makeLog(
        "info",
        `发送好友消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.user_id}`,
        true,
      )
      return this.sendMsg((msg: any) =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.user_id,
            ToType: 1,
            ...msg,
          }),
        (type: any, file: any) => this.uploadFile(data.self_id, `Friend${type}`, file),
        msg,
      )
    }

    sendMemberMsg(data: any, msg: any) {
      (globalThis as any).AgentRuntime.makeLog(
        "info",
        `发送群员消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}, ${data.user_id}`,
        true,
      )
      return this.sendMsg((msg: any) =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.user_id,
            GroupCode: data.group_id,
            ToType: 3,
            ...msg,
          }),
        (type: any, file: any) => this.uploadFile(data.self_id, `Friend${type}`, file),
        msg,
      )
    }

    sendGroupMsg(data: any, msg: any) {
      (globalThis as any).AgentRuntime.makeLog(
        "info",
        `发送群消息：${this.makeLog(msg)}`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      let ReplyTo: any
      if (data.message_id && data.seq && data.time)
        ReplyTo = {
          MsgSeq: data.seq,
          MsgTime: data.time,
          MsgUid: data.message_id,
        }

      return this.sendMsg((msg: any) =>
          this.sendApi(data.self_id, "MessageSvc.PbSendMsg", {
            ToUin: data.group_id,
            ToType: 2,
            ReplyTo,
            ...msg,
          }),
        (type: any, file: any) => this.uploadFile(data.self_id, `Group${type}`, file),
        msg,
      )
    }

    pickFriend(id: any, user_id: any) {
      const i: any = {
        ...(globalThis as any).AgentRuntime[id].fl.get(user_id),
        self_id: id,
        bot: (globalThis as any).AgentRuntime[id],
        user_id: user_id,
      }
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getAvatarUrl() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
        },
      }
    }

    pickMember(id: any, group_id: any, user_id: any) {
      const i: any = {
        ...(globalThis as any).AgentRuntime[id].fl.get(user_id),
        self_id: id,
        bot: (globalThis as any).AgentRuntime[id],
        user_id: user_id,
        group_id: group_id,
      }
      return {
        ...this.pickFriend(id, user_id),
        ...i,
        sendMsg: this.sendMemberMsg.bind(this, i),
      }
    }

    pickGroup(id: any, group_id: any) {
      const i: any = {
        ...(globalThis as any).AgentRuntime[id].gl.get(group_id),
        self_id: id,
        bot: (globalThis as any).AgentRuntime[id],
        group_id: group_id,
      }
      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        pickMember: this.pickMember(this, id, group_id),
        getAvatarUrl() {
          return `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
        },
      }
    }

    makeMessage(id: any, event: any) {
      const data: any = {
        event,
        bot: (globalThis as any).AgentRuntime[id],
        self_id: id,
        post_type: "message",
        message_id: event.MsgHead.MsgUid,
        seq: event.MsgHead.MsgSeq,
        time: event.MsgHead.MsgTime,
        user_id: event.MsgHead.SenderUin,
        sender: {
          user_id: event.MsgHead.SenderUin,
          nickname: event.MsgHead.SenderNick,
        },
        message: [] as any[],
        raw_message: "",
      }

      if (event.MsgBody.AtUinLists)
        for (const i of event.MsgBody.AtUinLists) {
          data.message.push({
            type: "at",
            qq: i.Uin,
            data: i,
          })
          data.raw_message += `[提及：${i.Uin}]`
        }

      if (event.MsgBody.Content) {
        data.message.push({
          type: "text",
          text: event.MsgBody.Content,
        })
        data.raw_message += event.MsgBody.Content
      }

      if (event.MsgBody.Images)
        for (const i of event.MsgBody.Images) {
          data.message.push({
            type: "image",
            url: i.Url,
            data: i,
          })
          data.raw_message += `[图片：${i.Url}]`
        }

      return data
    }

    makeFriendMessage(id: any, data: any) {
      if (!data.MsgBody) return
      data = this.makeMessage(id, data)
      data.message_type = "private"

      if (!(globalThis as any).AgentRuntime[id].fl.has(data.user_id)) (globalThis as any).AgentRuntime[id].fl.set(data.user_id, data.sender)

      (globalThis as any).AgentRuntime.makeLog(
        "info",
        `好友消息：[${data.sender.nickname}] ${data.raw_message}`,
        `${data.self_id} <= ${data.user_id}`,
        true,
      )
      data.tasker = 'opqbot';
      (globalThis as any).AgentRuntime.em('opqbot.message', data)
    }

    makeGroupMessage(id: any, data: any) {
      if (!data.MsgBody) return
      data = this.makeMessage(id, data)
      data.message_type = "group"
      data.sender.card = data.event.MsgHead.GroupInfo.GroupCard
      data.group_id = data.event.MsgHead.GroupInfo.GroupCode
      data.group_name = data.event.MsgHead.GroupInfo.GroupName

      if (!(globalThis as any).AgentRuntime[id].gl.has(data.group_id))
        (globalThis as any).AgentRuntime[id].gl.set(data.group_id, { group_id: data.group_id, group_name: data.group_name })
      let gml = (globalThis as any).AgentRuntime[id].gml.get(data.group_id)
      if (!gml) {
        gml = new Map();
        (globalThis as any).AgentRuntime[id].gml.set(data.group_id, gml)
      }
      if (!gml.has(data.user_id)) gml.set(data.user_id, data.sender)

      (globalThis as any).AgentRuntime.makeLog(
        "info",
        `群消息：[${data.group_name}, ${data.sender.nickname}] ${data.raw_message}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true,
      )
      data.tasker = 'opqbot';
      (globalThis as any).AgentRuntime.em('opqbot.message', data)
    }

    makeEvent(id: any, data: any) {
      switch (data.EventName) {
        case "ON_EVENT_FRIEND_NEW_MSG":
          this.makeFriendMessage(id, data.EventData)
          break
        case "ON_EVENT_GROUP_NEW_MSG":
          this.makeGroupMessage(id, data.EventData)
          break
        default:
          (globalThis as any).AgentRuntime.makeLog("warn", `未知事件：${(globalThis as any).logger.magenta(data.raw)}`, id)
      }
    }

    makeBot(id: any, ws: any) {
      const bot: any = {
        tasker: this,
        ws,

        uin: id,
        info: { id } as any,
        get nickname() {
          return this.info.nickname
        },
        get avatar() {
          return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
        },

        version: {
          id: this.id,
          name: this.name,
          version: this.version,
        },
        stat: { start_time: Date.now() / 1000 },

        pickFriend: this.pickFriend.bind(this, id),
        get pickUser() {
          return this.pickFriend
        },
        getFriendMap() {
          return this.fl
        },
        fl: new Map(),

        pickMember: this.pickMember.bind(this, id),
        pickGroup: this.pickGroup.bind(this, id),
        getGroupMap() {
          return this.gl
        },
        gl: new Map(),
        gml: new Map(),
      }
      ;(globalThis as any).AgentRuntime[id] = bot

      (globalThis as any).AgentRuntime.makeLog("mark", `${this.name}(${this.id}) ${this.version} 已连接`, id);
      (globalThis as any).AgentRuntime.em(`connect.${id}`, { self_id: id })
    }

    message(data: any, ws: any) {
      try {
        data = {
          ...JSON.parse(data),
          raw: (globalThis as any).AgentRuntime.String(data),
        }
      } catch (err: any) {
        return (globalThis as any).AgentRuntime.makeLog("error", ["解码数据失败", data, err])
      }

      const id = data.CurrentQQ
      if (id && data.CurrentPacket) {
        if ((globalThis as any).AgentRuntime[id]) (globalThis as any).AgentRuntime[id].ws = ws
        else this.makeBot(id, ws)

        return this.makeEvent(id, data.CurrentPacket)
      } else if (data.ReqId) {
        const cache = this.echo.get(data.ReqId)
        if (cache) return cache.resolve(data)
      }
      (globalThis as any).AgentRuntime.makeLog("warn", `未知消息：${(globalThis as any).logger.magenta(data.raw)}`, id)
    }

    load() {
      if (!Array.isArray((globalThis as any).AgentRuntime.wsf[this.path])) (globalThis as any).AgentRuntime.wsf[this.path] = [];
      (globalThis as any).AgentRuntime.wsf[this.path].push((ws: any, ...args: any[]) =>
        ws.on("message",(data: any) => (this.message as any)(data, ws, ...args)),
      )
    }
  })(),
)
