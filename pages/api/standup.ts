import { VercelRequest, VercelResponse } from '@vercel/node';
import { connectToDatabase } from './_connectToDatabase';
import {
  sendMsg,
  StandupGroup,
  Member,
  About,
  telegramTypes,
  getSubmissionDates,
} from './_helpers';

const standupTemplate = `Welcome!

To get started, add this bot to your chat and type /subscribe to subscribe them to your updates.

Afterwards, post a message here and it will automatically be sent to your chat at 11:00 am. You will receive a few reminders if you do not submit your standup before 8:00 am the day of.

You can send me videos / photos with captions, gifs, voice messages, and video messages! Perfect for letting your friends, family, coworkers know what you're up to today or accomplished yesterday!`;

const leaveStandupGroup = async (
  chatId: number,
  userId: number,
  about: About,
  messageId: number
) => {
  const { db } = await connectToDatabase();
  const removedUserFromGroup = await db.collection('users').updateOne(
    {
      userId,
    },
    { $pull: { groups: { chatId } } }
  );

  if (removedUserFromGroup.modifiedCount) {
    return await sendMsg(
      'This chat is now unsubscribed from your daily updates.',
      chatId,
      messageId
    );
  }

  return await sendMsg(
    'This chat is not yet subscribed to your daily updates.',
    chatId,
    messageId
  );
};

/**
 * The beginning
 *
 * @param userId
 */
const startBot = async (userId: number) => {
  const { db } = await connectToDatabase();

  await db.collection('users').updateOne(
    { userId },
    {
      $set: {
        botCanMessage: true,
      },
    }
  );
};

/** Just a random debugger */
const sendAboutMessage = async (
  chatId: number,
  userId: number,
  about: About,
  messageId: number
) => {
  const { db } = await connectToDatabase();

  const user = await db.collection('users').findOne({ userId });
  if (user) {
    return await sendMsg(JSON.stringify(user), chatId, messageId);
  }
  return await sendMsg(
    'You dont exist in this chat. Create a subscription with /subscribe',
    chatId,
    messageId
  );
};

async function uploadFile(url) {
  return fetch(
    `${process.env.UPLOAD_URL}/upload.php?key=${process.env.TELEGRAM_API_KEY}`,
    {
      method: 'POST',
      body: JSON.stringify({ url }),
    }
  );
}

/** Time to make an update */
const submitStandup = async (
  chatId: number,
  userId: number,
  messageId: number,
  body: any
) => {
  console.log(body);

  const isEdit = !!body?.edited_message;
  let message = body?.message || body?.edited_message;
  const type = Object.keys(message).find((a) => telegramTypes[a]);
  let file_id = message[type]?.file_id;

  if (type === 'photo') {
    file_id = message?.[type].slice(-1)[0].file_id;
  }

  let file_path = '';
  let successMessage = isEdit
    ? 'Your update has been edited.'
    : 'Your update has been submitted.';

  let sendMessage = true;
  const { db } = await connectToDatabase();

  // Album
  const groupId = message?.media_group_id;
  if (groupId) {
    const mediaGroup = await db
      .collection('users')
      .find({
        userId,
      })
      .project({
        updateArchive: {
          $filter: {
            input: '$updateArchive',
            as: 'update',
            cond: {
              $eq: ['$$update.body.message.media_group_id', groupId],
            },
          },
        },
      })
      .toArray();

    if (
      Array.isArray(mediaGroup) &&
      mediaGroup.length &&
      mediaGroup?.[0]?.updateArchive.length
    ) {
      console.log('Found a group', mediaGroup[0].updateArchive);
      // Found a group
      // Since the first message was already sent don't send more
      sendMessage = false;
    } else {
      // Alter message to let them know we see all their media
      successMessage = 'Your group media has been submitted.';
    }
  }

  if (file_id) {
    try {
      var download_url = `https://api.telegram.org/bot${process.env.TELEGRAM_API_KEY}/getFile?file_id=${file_id}`;
      console.log(download_url);
      const file = await fetch(download_url);
      const json = await file.json();
      console.log(json);
      if (json?.ok) {
        download_url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_API_KEY}/${json?.result?.file_path}`;
        const result = await uploadFile(download_url);
        const resultJson = await result.json();
        if (resultJson?.status === 'success') {
          file_path = `${process.env.UPLOAD_URL}/${json?.result?.file_path}`;
        } else {
          file_path = download_url;
        }
      }
    } catch (e) {}
  }
  const entities = message?.entities || message?.caption_entities;

  let dbResponse;
  if (isEdit) {
    dbResponse = await db.collection('users').updateOne(
      {
        'updateArchive.body.message.message_id': message.message_id,
      },
      {
        $set: {
          'updateArchive.$[elem]': {
            sent: false,
            file_id,
            entities,
            caption: message?.caption,
            type,
            file_path,
            createdAt: Date.now(),
            body: {
              ...body,
              edited_message: true,
              message: body.edited_message,
            },
          },
        },
      },
      {
        arrayFilters: [
          {
            'elem.body.message.message_id': message.message_id,
            'elem.sent': false,
          },
        ],
        multi: true,
      }
    );
  } else {
    dbResponse = await db.collection('users').updateOne(
      { userId },
      {
        $set: {
          submitted: true,
          botCanMessage: true,
        },
        $push: {
          updateArchive: {
            sent: false,
            file_id,
            entities,
            caption: message?.caption,
            type,
            file_path,
            createdAt: Date.now(),
            body,
          },
        },
      }
    );
  }

  if (!sendMessage) {
    // Already sent one
    console.log('Send message is false');
    return { status: 200 };
  }

  if (dbResponse.modifiedCount || dbResponse.modifiedCount) {
    return await sendMsg(successMessage, chatId, messageId, true);
  }

  if (isEdit && dbResponse.modifiedCount === 0) {
    return await sendMsg(
      "You can only edit a message that hasn't been sent yet!",
      chatId,
      messageId
    );
  }

  return await sendMsg(
    "You haven't subscribed any chats to your daily updates yet! Add this bot to your chat, then type /subscribe to subscribe them.",
    chatId,
    messageId
  );
};

const addToStandupGroup = async (
  chatId: number,
  userId: number,
  title: string,
  about: About,
  messageId: number
) => {
  const { db } = await connectToDatabase();

  const userExistsInGroup = await db.collection('users').findOne({
    userId,
    'groups.chatId': chatId,
  });

  console.log('adding');

  if (userExistsInGroup) {
    return await sendMsg(
      'This chat is already subscribed to your daily updates.',
      chatId,
      messageId
    );
  }

  const group: StandupGroup = {
    chatId,
    title,
  };

  const userExists = await db.collection('users').findOne({ userId });
  if (!userExists) {
    const member: Member = {
      userId,
      submitted: false,
      botCanMessage: false,
      updateArchive: [],
      about,
      groups: [group],
    };

    db.collection('users').insertOne(member);
  } else {
    db.collection('users').updateOne({ userId }, { $push: { groups: group } });
  }

  return await sendMsg(
    `This chat is now subscribed to your daily updates. Send me a message  @${process.env.NEXT_PUBLIC_BOT_NAME} to get started.`,
    chatId,
    messageId
  );
};

module.exports = async (req: VercelRequest, res: VercelResponse) => {
  if (req.query.key !== process.env.TELEGRAM_API_KEY) {
    return res.status(401).json({ status: 'invalid api key' });
  }

  const { body } = req;

  let message = body?.message || body?.edited_message;
  const { chat, entities, text, message_id, from } = message || {};

  // Don't try to parse this message if missing info
  if (!message || !Object.keys(message).some((a) => telegramTypes[a])) {
    console.log('Quitting early', message, body);
    return res.status(200).json({ status: 'invalid' });
  } else {
    console.log('Received valid request');
  }

  const isGroupCommand =
    (entities &&
      entities[0] &&
      entities[0].type === 'bot_command' &&
      chat.type === 'group') ||
    chat.type === 'supergroup';
  const isSubscribeCommand =
    isGroupCommand && text && text.search('/subscribe') !== -1;
  const isUnsubscribeCommand =
    isGroupCommand && text && text.search('/unsubscribe') !== -1;
  const isPrivateMessage = chat && chat.type === 'private';

  const isPrivateCommand =
    entities?.[0]?.type === 'bot_command' && chat?.type === 'private';
  const isPrivateStartCommand =
    isPrivateCommand && text && text.search('/start') !== -1;
  const isPreviewCommand =
    isPrivateCommand && text && text.search('/preview') !== -1;
  const isRestartCommand =
    isPrivateCommand && text && text.search('/restart') !== -1;
  if (isPreviewCommand) {
    const { previousSubmitTimestamp, nextSubmitTimestamp } =
      getSubmissionDates();

    const { db } = await connectToDatabase();
    const groupUpdates = await db
      .collection('users')
      .aggregate([
        {
          $project: { updateArchive: 1, groups: 1, about: 1 },
        },
        {
          $unwind: '$updateArchive',
        },
        {
          $match: {
            'about.id': from.id,
            'updateArchive.createdAt': {
              $gt: previousSubmitTimestamp,
              $lt: nextSubmitTimestamp,
            },
          },
        },
        {
          $group: {
            _id: '$about.id',
            about: { $first: '$about' },
            groups: { $first: '$groups' },
            latestUpdate: { $last: '$updateArchive' },
          },
        },
      ])
      .toArray();

    if (groupUpdates.length !== 0) {
      await sendMsg(
        "Here's a preview of your next update:",
        chat.id,
        message_id
      );

      const sendUpdatePromises = [];
      groupUpdates
        .filter((g: Member) => !!g.groups.length && !!g.latestUpdate)
        .forEach((user: Member) => {
          sendUpdatePromises.push(
            sendMsg(
              user.about.first_name,
              chat.id,
              null,
              true,
              user.latestUpdate
            )
          );
        });

      await Promise.allSettled(sendUpdatePromises);
    } else {
      await sendMsg(
        'You have no update to send yet! Send me your update to get started.',
        chat.id,
        message_id
      );
    }

    return res.json({ status: r.status });
  }

  if (isRestartCommand) {
    // not yet implemented, maybe never will
  }

  if (isPrivateStartCommand) {
    await startBot(from.id);
    const r = await sendMsg(standupTemplate, chat.id, message_id);
    return res.json({ status: r.status });
  } else if (isPrivateCommand) {
    const r = await sendMsg(
      'Add me to a chat, then send this command in that chat instead.',
      chat.id,
      message_id
    );
    return res.json({ status: r.status });
  } else if (isPrivateMessage) {
    // Valid request to save a new update to db
    const r = await submitStandup(chat.id, from.id, message_id, body);
    const status = r?.status || 200;
    return res.json({ status });
  }

  if (isSubscribeCommand) {
    const r = await addToStandupGroup(
      chat.id,
      from.id,
      chat.title,
      from,
      message_id
    );
    return res.json({ status: r.status });
  } else if (isUnsubscribeCommand) {
    const r = await leaveStandupGroup(chat.id, from.id, from, message_id);
    return res.json({ status: r.status });
  } else {
    return res.status(200).json({ status: 'invalid command' });
  }
};
