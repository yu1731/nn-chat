'use strict';
const pug = require('pug');
const Cookies = require('cookies');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [ 'query' ] });
const util = require('./handler-util');
const { currentThemeKey } = require('../config')

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const relativeTime = require('dayjs/plugin/relativeTime');
require('dayjs/locale/ja');
dayjs.locale('ja');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.tz.setDefault('Asia/Tokyo');
const crypto = require('node:crypto');

const oneTimeTokenMap = new Map(); // キーをユーザ名、値をトークンとする連想配列
const emojis = ['👍', '❤️', '😂'];

async function handle(req, res) {
  const cookies = new Cookies(req, res);
  const currentTheme = cookies.get(currentThemeKey) || 'light';
  const options = { maxAge: 30 * 86400 * 1000 };
  cookies.set(currentThemeKey, currentTheme, options);
  switch (req.method) {
    case 'GET':
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });
      const posts = await prisma.post.findMany({
        orderBy: {
          id: 'asc'
        },
        include: {
          reactions: true
        }
      });
      posts.forEach(post => {
        post.relativeCreatedAt = dayjs(post.createdAt).tz().fromNow();
        post.absoluteCreatedAt = dayjs(post.createdAt).tz().format('YYYY年MM月DD日 HH時mm分ss秒');
        post.reactionSummary = emojis.map(emoji => {
          const matched = post.reactions.filter(r => r.emoji === emoji);
          return {
            emoji,
            count: matched.length,
            reactedByMe: matched.some(r => r.userName === req.user)
          };
        });
      });
      const oneTimeToken = crypto.randomBytes(8).toString('hex');
      oneTimeTokenMap.set(req.user, oneTimeToken);
      res.end(pug.renderFile('./views/posts.pug', {
        currentTheme,
        posts,
        user: req.user,
        oneTimeToken
      }));
      console.info(
        `閲覧されました: user: ${req.user}, ` +
        `remoteAddress: ${req.socket.remoteAddress}, ` +
        `userAgent: ${req.headers['user-agent']} `
      );
      break;
    case 'POST':
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      }).on('end', async () => {
        const params = new URLSearchParams(body);
        const content = params.get('content');
        const requestedOneTimeToken = params.get('oneTimeToken');
        if (!content) {
          handleRedirectPosts(req, res);
          return;
        }
        if (!requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }
        if (oneTimeTokenMap.get(req.user) !== requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }
        console.info(`送信されました: ${content}`);
        await prisma.post.create({
          data: {
            content,
            postedBy: req.user
          }
        });
        oneTimeTokenMap.delete(req.user);
        handleRedirectPosts(req, res);
      });
      break;
    default:
      util.handleBadRequest(req, res);
      break;
  }
}

function handleRedirectPosts(req, res) {
  res.writeHead(303, {
    'Location': '/posts'
  });
  res.end();
}

function handleDelete(req, res) {
  switch (req.method) {
    case 'POST':
      let body = '';
      req.on('data',(chunk) => {
        body += chunk;
      }).on('end', async () => {
        const params = new URLSearchParams(body);
        const id = parseInt(params.get('id'));
        const requestedOneTimeToken = params.get('oneTimeToken');
        if (!id) {
          util.handleBadRequest(req, res);
          return;
        }
        if (!requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }
        if (oneTimeTokenMap.get(req.user) !== requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }
        const post = await prisma.post.findUnique({
          where: { id }
        });
        if (!post) {
          util.handleBadRequest(req, res);
          return;
        }
        if (req.user === post.postedBy || req.user === 'admin') {
          await prisma.post.delete({
            where: { id }
          });
          console.info(
            `削除されました: user: ${req.user}, ` +
              `remoteAddress: ${req.socket.remoteAddress}, ` +
              `userAgent: ${req.headers['user-agent']} `
          );
          oneTimeTokenMap.delete(req.user);
          handleRedirectPosts(req, res);
        }
      });
      break;
    default:
      util.handleBadRequest(req, res);
      break;
  }
}

function handleReaction(req, res) {
  switch (req.method) {
    case 'POST':
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      }).on('end', async () => {
        const params = new URLSearchParams(body);
        const postId = parseInt(params.get('postId'), 10);
        const emoji = params.get('emoji');
        const requestedOneTimeToken = params.get('oneTimeToken');

      if (!postId || !emojis.includes(emoji)) {
        util.handleBadRequest(req, res);
        return;
      }
      if (!requestedOneTimeToken || oneTimeTokenMap.get(req.user) !== requestedOneTimeToken) {
        util.handleBadRequest(req, res);
        return;
      }
      const post = await prisma.post.findUnique({
        where: { id: postId}
      });
      if (!post) {
        util.handleBadRequest(req, res);
        return;
      }
      const existing = await prisma.reaction.findUnique({
        where: {
          postId_userName_emoji: {
            postId,
            userName: req.user,
            emoji
          }
        }
      });

      if (existing) {
        await prisma.reaction.delete({
          where: { id: existing.id }
        });
      } else {
        await prisma.reaction.create({
          data: {
            postId,
            userName: req.user,
            emoji
          }
        });
      }
      oneTimeTokenMap.delete(req.user);
      handleRedirectPosts(req, res);
    });
    break;
  default:
    util.handleBadRequest(req, res);
    break;
  }
}
 
module.exports = {
  handle,
  handleDelete,
  handleReaction,
};