// @ts-nocheck
AgentRuntime.tasker.push(
  new (class GSUIDCoreTasker {
    id = "GSUIDCore"
    name = "早柚核心(时雨崽)"
    path = this.id

    makeLog(msg) {
      return AgentRuntime.String(msg).replace(/base64:\/\/.*?"/g, 'base64://..."')
    }

    makeButton(button) {
      const msg = {
        text: button.text,
        pressed_text: button.clicked_text,
        ...button.GSUIDCore,
      }

      if (button.input) {
        msg.data = button.input
        msg.action = 2
      } else if (button.callback) {
        msg.data = button.callback
        msg.action = 1
      } else if (button.link) {
        msg.data = button.link
        msg.action = 0
      } else return false

      if (button.permission) {
        if (button.permission === "admin") {
          msg.permission = 1
        } else {
          msg.permission = 0
          if (!Array.isArray(button.permission)) button.permission = [button.permission]
          msg.specify_user_ids = button.permission
        }
      }
      return msg
    }

    makeButtons(button_square) {
      const msgs = []
      for (const button_row of button_square) {
        const buttons = []
        for (let button of button_row) {
          button = this.makeButton(button)
          if (button) buttons.push(button)
        }
        msgs.push(buttons)
      }
      return msgs
    }

    async makeMsg(msg) {
      if (!Array.isArray(msg)) msg = [msg]
      const msgs = []
      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", text: i }

        if (i.file) {
          i.file = await AgentRuntime.Buffer(i.file, {
            http: true,
            size: 10485760,
          })
          if (Buffer.isBuffer(i.file)) i.file = `base64://${i.file.toBase64()}`
        }

        switch (i.type) {
          case "text":
            i = { type: "text", data: i.text }
            break
          case "image":
            i = { type: "image", data: i.file }
            break
          case "record":
            i = { type: "record", data: i.file }
            break
          case "video":
            i = { type: "file", data: i.file }
            break
          case "file":
            i = { type: "file", data: i.file }
            break
          case "at":
            i = { type: "at", data: i.qq }
            break
          case "reply":
            i = { type: "reply", data: i.id }
            break
          case "button":
            i = { type: "buttons", data: this.makeButtons(i.data) }
            break
          case "markdown":
            break
          case "node": {
            const array = []
            for (const { message } of i.data) array.push(...(await this.makeMsg(message)))
            i.data = array
            break
          }
          case "raw":
            i = i.data
            break
          default:
            i = { type: "text", data: AgentRuntime.String(i) }
        }
        msgs.push(i)
      }
      return msgs
    }

    async sendFriendMsg(data, msg) {
      const content = await this.makeMsg(msg)
      AgentRuntime.makeLog(
        "info",
        `发送好友消息：${this.makeLog(content)}`,
        `${data.self_id} => ${data.user_id}`,
        true,
      )
      data.bot.sendApi({
        bot_id: data.bot.bot_id,
        bot_self_id: data.bot.bot_self_id,
        target_type: "direct",
        target_id: data.user_id,
        content,
      })
      return { message_id: Date.now().toString(36) }
    }

    async sendGroupMsg(data, msg) {
      const target = data.group_id.split("-")
      const content = await this.makeMsg(msg)
      AgentRuntime.makeLog(
        "info",
        `发送群消息：${this.makeLog(content)}`,
        `${data.self_id} => ${data.group_id}`,
        true,
      )
      data.bot.sendApi({
        bot_id: data.bot.bot_id,
        bot_self_id: data.bot.bot_self_id,
        target_type: target[0],
        target_id: target[1],
        content,
      })
      return { message_id: Date.now().toString(36) }
    }

    pickFriend(id, user_id) {
      const i = {
        ...AgentRuntime[id].fl.get(user_id),
        self_id: id,
        bot: AgentRuntime[id],
        user_id: user_id,
      }
      return {
        ...i,
        sendMsg: this.sendFriendMsg.bind(this, i),
        getAvatarUrl: () => i.avatar,
      }
    }

    pickMember(id, group_id, user_id) {
      const i = {
        ...AgentRuntime[id].fl.get(user_id),
        ...AgentRuntime[id].gml.get(group_id)?.get(user_id),
        self_id: id,
        bot: AgentRuntime[id],
        group_id: group_id,
        user_id: user_id,
      }
      return {
        ...this.pickFriend(id, user_id),
        ...i,
      }
    }

    pickGroup(id, group_id) {
      const i = {
        ...AgentRuntime[id].gl.get(group_id),
        self_id: id,
        bot: AgentRuntime[id],
        group_id: group_id,
      }
      return {
        ...i,
        sendMsg: this.sendGroupMsg.bind(this, i),
        pickMember: this.pickMember.bind(this, id, group_id),
      }
    }

    makeBot(data, ws) {
      AgentRuntime[data.self_id] = {
        tasker: this,
        ws: ws,
        get sendApi() {
          return this.ws.sendMsg
        },
        uin: data.self_id,
        bot_id: data.raw.bot_id,
        bot_self_id: data.raw.bot_self_id,
        stat: { start_time: Date.now() / 1000 },
        version: {
          id: this.id,
          name: this.name,
        },
        pickFriend: this.pickFriend.bind(this, data.self_id),
        get pickUser() {
          return this.pickFriend
        },
        pickMember: this.pickMember.bind(this, data.self_id),
        pickGroup: this.pickGroup.bind(this, data.self_id),
        fl: new Map(),
        gl: new Map(),
        gml: new Map(),
      }
      data.bot = AgentRuntime[data.self_id]

      AgentRuntime.makeLog("mark", `${this.name}(${this.id}) 已连接`, data.self_id)
      AgentRuntime.em(`connect.${data.self_id}`, data)
    }

    message(raw, ws) {
      try {
        raw = JSON.parse(raw)
      } catch (err) {
        return AgentRuntime.makeLog("error", ["解码数据失败", raw, err])
      }

      const data = {
        raw,
        self_id: raw.bot_self_id,
        post_type: "message",
        message_id: raw.msg_id,
        get user_id() {
          return this.sender.user_id
        },
        sender: {
          ...raw.sender,
          user_id: raw.user_id,
          user_pm: raw.user_pm,
        },
        message: [],
        raw_message: "",
      }

      if (AgentRuntime[data.self_id]) {
        data.bot = AgentRuntime[data.self_id]
        data.bot.ws = ws
      } else {
        this.makeBot(data, ws)
      }

      data.bot.fl.set(data.user_id, {
        ...data.bot.fl.get(data.user_id),
        ...data.sender,
      })

      for (const i of raw.content) {
        switch (i.type) {
          case "text":
            data.message.push({ type: "text", text: i.data })
            data.raw_message += i.data
            break
          case "image":
            data.message.push({ type: "image", url: i.data })
            data.raw_message += `[图片：${i.data}]`
            break
          case "file":
            data.message.push({ type: "file", url: i.data })
            data.raw_message += `[文件：${i.data}]`
            break
          case "at":
            data.message.push({ type: "at", qq: i.data })
            data.raw_message += `[提及：${i.data}]`
            break
          case "reply":
            data.message.push({ type: "reply", id: i.data })
            data.raw_message += `[回复：${i.data}]`
            break
          case "node":
            data.message.push({ type: "node", data: i.data })
            data.raw_message += `[合并转发：${AgentRuntime.String(i.data)}]`
            break
          default:
            data.message.push(i)
            data.raw_message += AgentRuntime.String(i)
        }
      }

      if (raw.user_type === "direct") {
        data.message_type = "private"
        AgentRuntime.makeLog(
          "info",
          `好友消息：${data.raw_message}`,
          `${data.self_id} <= ${data.user_id}`,
          true,
        )
      } else {
        data.message_type = "group"
        data.group_id = `${raw.user_type}-${raw.group_id}`

        if (!data.bot.gl.has(data.group_id))
          data.bot.gl.set(data.group_id, { group_id: data.group_id })
        let gml = data.bot.gml.get(data.group_id)
        if (!gml) {
          gml = new Map()
          data.bot.gml.set(data.group_id, gml)
        }
        gml.set(data.user_id, {
          ...gml.get(data.user_id),
          ...data.sender,
        })

        AgentRuntime.makeLog(
          "info",
          `群消息：${data.raw_message}`,
          `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
          true,
        )
      }

      data.tasker = 'gsuidcore'
      AgentRuntime.em('gsuidcore.message', data)
    }

    load() {
      if (!Array.isArray(AgentRuntime.wsf[this.path])) AgentRuntime.wsf[this.path] = []
      AgentRuntime.wsf[this.path].push((ws, ...args) =>
        ws.on("message", data => this.message(data, ws, ...args)),
      )
    }
  })(),
)
