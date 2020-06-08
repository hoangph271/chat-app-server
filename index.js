const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const http = require('http')
const SocketIO = require('socket.io')
const { MongoClient, ObjectId, Db } = require('mongodb')

/**
 * @returns {Promise<Db>}
 */
const connectDb = () => new Promise((resolve, reject) => {
  const dbUrl = 'mongodb://db:NHrGr$DFdQD2NYL@ds153093.mlab.com:53093/chat-app-db'

  MongoClient.connect(dbUrl, {
    useUnifiedTopology: true,
    useNewUrlParser: true,
  }, (err, client) => {
    if (err) {
      reject(err)
      return
    }

    process.once('exit', () => client.close())

    const db = client.db('chat-app-db')

    resolve(db)
  })
})

;(async () => {
  const app = express()
  const server = http.Server(app)
  const socketMap = new Map()

  app.use(cors({
    credentials: true,
    origin: [
      'http://localhost:8080',
      'https://practical-turing-272195.netlify.app',
    ],
  }))

  const io = SocketIO(server, {
    origins: [
      'http://localhost:8080',
      'https://practical-turing-272195.netlify.app',
    ]
  })

  const db = await connectDb()
  const dbUsers = db.collection('users')
  const dbMessages = db.collection('messages')
  const jsonParser = bodyParser.json()

  app.get('/messages/:threadId', async (req, res) => {
    const { threadId } = req.params
    const messages = await dbMessages.find({ threadId }).toArray()

    res.send(messages)
  })
  app.get('/users', async (_, res) => {
    const users = await dbUsers.find().toArray()

    res.send(users)
  })
  app.get('/users/friends/:_id', async (req, res) => {
    const _id = new ObjectId(req.params._id)
    const { friends = [] } = await dbUsers.findOne({ _id })

    const friendsWithStatus = friends.map(friend => {
      return {
        ...friend,
        isOnline: (socketMap.get(friend._id) || { size: 0 }).size > 0,
      }
    })

    res.send(friendsWithStatus)
  })
  app.delete('/users/friends/:_id/:friendId', async (req, res) => {
    const _id = new ObjectId(req.params._id)
    const friendId = new ObjectId(req.params.friendId)

    await dbUsers.updateOne(
      { _id },
      {
        $pull: {
          friends: {
            _id: req.params.friendId,
          }
        }
      }
    )
    await dbUsers.updateOne(
      { _id: friendId },
      {
        $pull: {
          friends: {
            _id: req.params._id,
          }
        }
      }
    )

    res.sendStatus(200)

    ;(socketMap.get(req.params._id) || []).forEach(socket => {
      socket.emit('removeFriend', req.params.friendId)
    })
    ;(socketMap.get(req.params.friendId) || []).forEach(socket => {
      socket.emit('removeFriend', req.params._id)
    })
  })
  app.post('/users/friends', jsonParser, async (req, res) => {
    const _id = new ObjectId(req.body._id)
    const friendId = new ObjectId(req.body.friendId)

    await dbUsers.updateOne(
      { _id },
      {
        $push: {
          friends: {
            _id: req.body.friendId,
            email: req.body.friendEmail,
          }
        }
      }
    )
    await dbUsers.updateOne(
      { _id: friendId },
      {
        $push: {
          friends: {
            _id: req.body._id,
            email: req.body.email,
          }
        }
      }
    )

    res.sendStatus(200)

    ;(socketMap.get(req.body._id) || []).forEach(socket => {
      socket.emit('addFriend', {
        _id: req.body.friendId,
        email: req.body.friendEmail,
        isOnline: (socketMap.get(req.body.friendId) || { size: 0 }).size > 0,
      })
    })
    ;(socketMap.get(req.body.friendId) || []).forEach(socket => {
      socket.emit('addFriend', {
        _id: req.body._id,
        email: req.body.email,
        isOnline: (socketMap.get(req.body._id) || { size: 0 }).size > 0,
      })
    })
  })
  app.post('/users', jsonParser, async (req, res) => {
    const { email } = req.body

    const exists = await dbUsers.findOne({ email })

    if (exists) {
      res.sendStatus(200)
      return
    }

    dbUsers.insertOne({ email })
    res.sendStatus(200)

    io.sockets.emit('updateUsers')
  })
  app.all('*', (_, res) => res.sendStatus(404))

  const getUserSockets = _id => socketMap.get(_id) || new Set()

  io.on('connection', (socket) => {
    let _userId

    socket.on('userId', async (userId) => {
      _userId = userId

      socketMap.has(userId)
        ? socketMap.get(userId).add(socket)
        : socketMap.set(userId, new Set([socket]))

      if (socketMap.get(userId).size === 1) {
        const { friends } = await dbUsers.findOne({ _id: new ObjectId(_userId) })

        ;(friends || []).forEach(friend => {
          ;(socketMap.get(friend._id) || []).forEach(friendSocket => {
            friendSocket.emit('@friendOnline', _userId)
          })
        })
      }

      socket.emit('updateFriends')
    })
    socket.on('@send-message', async ({ _id, message }) => {
      const threadId = [_userId, _id].sort().join('_')
      const insertRes = await dbMessages.insertOne({
        threadId,
        time: Date.now(),
        from: _userId,
        to: _id,
        content: message,
      })

      getUserSockets(_id).forEach(socket => {
        socket.emit('@new-message', {
          ...insertRes.ops[0],
        })
      })
      getUserSockets(_userId).forEach(socket => {
        socket.emit('@new-message', {
          ...insertRes.ops[0],
        })
      })
    })

    socket.emit('updateUsers')
    socket.on('disconnect', async () => {
      getUserSockets(_userId).delete(socket)

      if (getUserSockets(_userId).size === 0) {
        const { friends = [] } = await dbUsers.findOne({ _id: new ObjectId(_userId) })

        friends.forEach(friend => {
          getUserSockets(friend._id).forEach(friendSocket => {
            friendSocket.emit('@friendOffline', _userId)
          })
        })
      }
    })
  })

  const { PORT = 3000 } = process.env

  server.listen(PORT, () =>  console.info(`Runnin' at PORT - ${PORT}`))
})()
