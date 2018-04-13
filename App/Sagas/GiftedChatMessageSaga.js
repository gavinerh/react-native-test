// ...
import { delay, buffers } from 'redux-saga'
import { take, actionChannel, call, put, select } from 'redux-saga/effects'
import R from 'ramda'
import { DOMParser } from 'react-native-html-parser'

// Import Reducers / Actions for Chat Messages
import { GiftedChatMessageActions } from '../Redux/GiftedChatMessageRedux'
import { MessageActions, AuthorTypes, MessageStates } from '../Redux/MessageRedux'
// Import Reducers / Actions for Chat Messages
import { GUIActions } from '../Redux/GUIRedux'
import { StoryProgressActions } from '../Redux/StoryProgressRedux'
import AppConfig from '../Config/AppConfig'

import Log from '../Utils/Log'
const log = new Log('Sagas/GiftedChatMessageSaga')

let oldestShownMessage = -1

// selectors
const allMessages = (state) => state.messages

let addedHistoricalMessages = []
// const getNumberOfMessages = (state) => Object.keys(state.messages).length
// const getNumberOfShownMessages = state => state.guistate.numberOfShownMessages

export function * initializeGiftedChat (action) {
  const { hydrationCompleted } = action
  if (!hydrationCompleted) {
    return
  }
  log.info('Initializing gifted chat...')

  yield call(loadEarlierMessages)
  yield put({ type: GiftedChatMessageActions.GIFTED_CHAT_INITIALIZED })
}

// This saga watches for new messages from the server which will always dispatched with type "NEW_OR_UPDATED_MESSAGE_FOR_GIFTED_CHAT"
export function * watchNewOrUpdatedMessageForGiftedChat (action) {
  const buffer = buffers.expanding()
  const newOrUpdatedMessagesChannel = yield actionChannel(MessageActions.NEW_OR_UPDATED_MESSAGE_FOR_GIFTED_CHAT, buffer)

  // Listen on initialize event
  yield take(GiftedChatMessageActions.GIFTED_CHAT_INITIALIZED)

  log.info('Starting to watch for new or updated messages...')

  while (true) {
    const { message } = yield take(newOrUpdatedMessagesChannel)
    log.debug('New or updated message:', message)

    // Check if we already have a version of this message
    let guiClientVersion = yield call(getClientVersionOfGuiMessage, message['client-id'])

    // If we have a message with this client-id already...
    if (guiClientVersion !== null) {
      if (guiClientVersion < message['client-version']) {
        // Update the messages immediately
        yield put({ type: GiftedChatMessageActions.GIFTED_CHAT_UPDATE_MESSAGES, serverMessage: message })
      }
    // If its a new message, add it with some typing-delay
    } else {
      let fakeTimestamp = null

      // Mark message as read
      if (!message['client-read']) {
        fakeTimestamp = yield call(checkForDelayedPresentation, message)

        yield put({ type: MessageActions.MESSAGE_READ_BY_GIFTED_CHAT, messageId: message['client-id'], fakeTimestamp })
      }
      // Convert the servermessage to giftedchat-format
      let giftedChatMessages = yield call(convertServerMessageToGiftedChatMessages, message, fakeTimestamp)

      // Messages with faked timestamps should be shown with typing delay, others not
      if (fakeTimestamp == null) {
        yield call(addMessages, giftedChatMessages)
      } else {
        yield call(addMessagesWithDelay, giftedChatMessages)
      }
    }

    // Inform GUI state if another message is expected
    if (buffer.isEmpty()) {
      yield put({ type: GUIActions.SET_CURRENTLY_FURTHER_MESSAGES_EXPECTED, currentlyFurtherMessagesExpected: false })
    } else {
      yield put({ type: GUIActions.SET_CURRENTLY_FURTHER_MESSAGES_EXPECTED, currentlyFurtherMessagesExpected: true })
    }
  }
}

export function * loadEarlierMessages () {
  log.debug('Loading earlier messages...')

  const messages = yield select(allMessages)

  if (messages === undefined || messages === null) {
    return
  }

  let messagesKeys = Object.keys(messages)

  let minimalMessagesToLoad = 0
  let messageToStart = 0
  if (oldestShownMessage === -1) {
    log.debug('Startup case...')
    minimalMessagesToLoad = AppConfig.config.messages.initialNumberOfMinimalShownMessages
    messageToStart = messagesKeys.length - 1
  } else {
    log.debug('Load earlier case...')
    minimalMessagesToLoad = AppConfig.config.messages.incrementShownMessagesBy
    messageToStart = oldestShownMessage - 1
  }

  log.debug('Load at least ', minimalMessagesToLoad, ' messages starting with ', messageToStart)

  let commandsToCheck = []
  let addedMessages = 0
  let onlyStickyMessages = false
  for (let i = messageToStart; i >= 0; i--) {
    const messageToAdd = { ...messages[messagesKeys[i]] }
    let giftedChatMessages = yield call(convertServerMessageToGiftedChatMessages, messageToAdd)

    // Cancel if already shown enough messages
    if (addedMessages >= minimalMessagesToLoad && messageToAdd['client-read']) {
      onlyStickyMessages = true
    }

    if (!onlyStickyMessages) {
      // Remember commands
      if (giftedChatMessages.length === 1 && giftedChatMessages[0].type === 'hidden-command') {
        commandsToCheck.unshift(giftedChatMessages[0])
      }

      // Remeber oldest shown message
      oldestShownMessage = i

      // Mark message as read
      if (!messageToAdd['client-read']) {
        yield put({ type: MessageActions.MESSAGE_READ_BY_GIFTED_CHAT, messageId: messageToAdd['client-id'] })
      }

      // Remember real number of already added messages
      for (const giftedChatMessage of giftedChatMessages) {
        if (giftedChatMessage.custom.visible) {
          addedMessages++
        }
      }
    }

    const giftedChatMessagesReversed = giftedChatMessages.reverse()
    // Add message
    for (const giftedChatMessage of giftedChatMessagesReversed) {
      if (!onlyStickyMessages || (onlyStickyMessages && giftedChatMessage.custom.sticky)) {
        if (!addedHistoricalMessages.includes(giftedChatMessage._id)) {
          log.debug('Adding message ', giftedChatMessage._id)
          addedHistoricalMessages.push(giftedChatMessage._id)
          yield call(addMessages, [giftedChatMessage], true)
        }
      }
    }
  }

  // Execute commands
  for (const commandMessage of commandsToCheck) {
    yield put({ type: MessageActions.EXECUTE_COMMAND, messageId: commandMessage._id.substring(0, commandMessage._id.lastIndexOf('-')) })
  }

  // Show or hide load earlier button
  if (oldestShownMessage <= 0) {
    oldestShownMessage = 0
    yield put({ type: GUIActions.HIDE_LOAD_EARLIER })
  } else {
    yield put({ type: GUIActions.SHOW_LOAD_EARLIER })
  }
}

function * checkForDelayedPresentation (message) {
  // Server message should have a fake timestamp if never than 5 minutes
  if (message['author'] === 'SERVER') {
    const now = Date.now()
    const messageTimestamp = message['message-timestamp'] * 1

    if ((messageTimestamp + 300000) > now) {
      return now
    }
  }

  return null
}

// Returns the client-version of a message in the current giftedchat-store with the given client-id
// or 'undefined' if there is currently no message with the given id
function * getClientVersionOfGuiMessage (messageId) {
  // define selector
  const getMessageById = (state) => {
    // if there is a corresponding giftedChat message, there will always be the first subId = '-0'
    let message = state.giftedchatmessages[messageId + '-0']
    return message
  }
  // use selector to filter state
  let message = yield select(getMessageById)
  // If the message was found
  if (message) {
    return message.custom.clientVersion
  // else return undefined
  } else {
    return null
  }
}

// Add messages to giftedChat immediately
function * addMessages (messages = [], addToStart = false) {
  for (let i = 0; i < messages.length; i++) {
    let message = { ...messages[i] }

    // Fire commands (only for newly added messages, not for load earlier messages)
    if (!addToStart && message.type === 'hidden-command') {
      yield put({ type: MessageActions.EXECUTE_COMMAND, messageId: message._id.substring(0, message._id.lastIndexOf('-')) })
    }

    yield put({ type: GiftedChatMessageActions.GIFTED_CHAT_ADD_MESSAGE, message, addToStart })
  }
}

// Add messages to giftedChat with a proper human typing delay (typing indicator will be shown)
function * addMessagesWithDelay (messages = []) {
  for (let i = 0; i < messages.length; i++) {
    let message = { ...messages[i] }

    // set animation flag (messages with animations, e.g. input-options should only animate once..)
    message.custom['shouldAnimate'] = true
    // If the message is sent from coach...
    if (message.user._id === 2) {
      // ...and it's a Text Message, add a typing delay from Coach ;)
      let ms = 0
      if (message.type === 'text' && message.custom.visible) {
        yield put({ type: GUIActions.SHOW_COACH_IS_TYPING })
        ms = calculateMessageDelay(message)
        // Attention: timers higher than 1000 ms don't work properly with chrome debugger (see: https://github.com/facebook/react-native/issues/9436)
        if (AppConfig.config.typingIndicator.fastMode) {
          yield delay(50)
        } else {
          yield delay(Math.floor(ms / 5 * 4))
        }
        yield put({ type: GUIActions.HIDE_COACH_IS_TYPING })
      } else {
        if (AppConfig.config.typingIndicator.fastMode) {
          yield delay(50)
        } else {
          yield delay(AppConfig.config.typingIndicator.interactiveElementDelay)
        }
      }
      // Add message to chat
      yield put({ type: GiftedChatMessageActions.GIFTED_CHAT_ADD_MESSAGE, message })

      // Wait again for a while (if ms have been calculated)
      if (AppConfig.config.typingIndicator.fastMode) {
        yield delay(50)
      } else {
        yield delay(Math.floor(ms / 5))
      }

    // If it's a message from user or a system message, add it directly
    } else {
      // Fire commands
      if (message.type === 'hidden-command') {
        yield put({ type: MessageActions.EXECUTE_COMMAND, messageId: message._id.substring(0, message._id.lastIndexOf('-')) })
      }
      // Add message to chat
      yield put({ type: GiftedChatMessageActions.GIFTED_CHAT_ADD_MESSAGE, message })
    }
  }
}

// Function to determine a proper "human" delay for typing a Message
function calculateMessageDelay (message) {
  // Typing speed of our Coach
  let wordsPerMinute = AppConfig.config.typingIndicator.coachTypingSpeed
  let charPerMinute = wordsPerMinute * 5
  // avg seconds per character
  let sPerChar = 1 / (charPerMinute / 60)
  // milliseconds
  let ms = sPerChar * message.text.length * 1000
  // Max delay
  if (ms > AppConfig.config.typingIndicator.maxTypingDelay) ms = AppConfig.config.typingIndicator.maxTypingDelay
  log.debug('Calculated message delay is ', ms / 1000, ' seconds')
  return ms
}

function * convertServerMessageToGiftedChatMessages (serverMessage, fakeTimestamp = null) {
  // Actively ignore specific types
  if (serverMessage.type === 'VARIABLE') {
    return []
  }

  // since some servermessages need to be split into several givtedChat messages, we will return an array
  let messages = []
  // add a sub-id to the gitedchat messages
  let subId = 0

  // We need to convert our server messages into GiftedChat messages
  let message = {
    _id: serverMessage['client-id'] + '-' + subId++,
    custom: {
      clientVersion: serverMessage['client-version'],
      clientStatus: serverMessage['client-status'],
      linkedMedia: serverMessage['contains-media'],
      linkedSurvey: serverMessage['contains-survey'],
      sticky: serverMessage['sticky'],
      disabled: serverMessage['disabled'],
      visible: true
    }
  }

  switch (serverMessage.author) {
    // Message from server
    case AuthorTypes.SERVER:
      message.text = serverMessage['server-message']

      if (fakeTimestamp != null) {
        message.createdAt = fakeTimestamp
      } else if (serverMessage['fake-timestamp'] !== undefined) {
        message.createdAt = serverMessage['fake-timestamp']
      } else {
        message.createdAt = serverMessage['message-timestamp']
      }
      message.user = {
        _id: 2
      }
      break
    // Message from user
    case AuthorTypes.USER:
      message.text = serverMessage['user-message']
      message.createdAt = serverMessage['user-timestamp']
      message.user = {
        _id: 1
      }
      break
    default: {}
  }

  // convention: If the serverMessage contains media, but the text doesn't include a link to it, add a the media as a new bubble at the bottom of the message
  if (serverMessage['contains-media'] && !message.text.includes('####LINKED_MEDIA_OBJECT####')) {
    // if the message is empty, completely replace it to prevent the empty bubble
    if (message.text === '') message.text = '####LINKED_MEDIA_OBJECT####'
    // otherwise, add it to the bottom
    else message.text = message.text + '\n---\n####LINKED_MEDIA_OBJECT####'
  }

  // ...same convention for linked surveys
  if (serverMessage['contains-survey'] && !message.text.includes('####LINKED_SURVEY####')) {
    // if the message is empty, completely replace it to prevent the empty bubble
    if (message.text === '') message.text = '####LINKED_SURVEY####'
    else message.text = message.text + '\n---\n####LINKED_SURVEY####'
  }

  // Check which kind of Message was recieved and handle it accordingly
  switch (serverMessage.type) {
    // Plain text message
    // User intention
    case 'INTENTION': {
      message.type = 'intention'
      messages.push(message)
      break
    }
    case 'PLAIN': {
      // first create an array, so the following forEach loop will be called at least one time
      let subMessages = [message.text]
      // this is just to prevent errors in case the message contains no text (e.g. plain image)
      if (message.text) {
        // if there is text, split the message to several bubbles (seperated by "---")
        subMessages = message.text.split('\n---\n')
      }
      subId = 0
      subMessages.forEach(subMessage => {
        let newMessage = R.clone(message)
        newMessage.text = subMessage
        newMessage.type = 'text'
        newMessage._id = serverMessage['client-id'] + '-' + subId++
        messages.push(newMessage)
      })
      break
    }
    // Server Command
    case 'COMMAND': {
      // in a command message, the server-message field contains the command type
      const commandArray = serverMessage['server-message'].split(' ')
      let commandType = commandArray[0]
      let commandValue = null
      if (commandArray.length > 1) {
        commandValue = commandArray[1]
      }
      message.user = { _id: 1 }

      switch (commandType) {
        // Show Info Command
        case 'show-backpack-info':
        case 'show-info': {
          message.type = 'open-component'
          // Default title
          let buttonTitle = ''
          let content = serverMessage.content  // .replace(/\n/g, '')
          // Button Title is delivered in message-Field
          const pattern = new RegExp('<button>(.*)</button>', 'g')
          const regExpResult = pattern.exec(content)
          if (regExpResult) {
            buttonTitle = regExpResult[1]
            content = content.replace(regExpResult[0], '')
          }
          message.custom = {
            ...message.custom,
            // Info-Content delievered by server in DS-Message
            content,
            // Component to be opened on Tap
            component: 'rich-text',
            buttonTitle: buttonTitle,
            infoId: commandValue
          }
          // Only remember backpack infos
          if (commandType === 'show-backpack-info') {
            if (commandValue === null) log.warn('Received show-backpack-info without id! Command: ' + serverMessage['server-message'])
            else {
              let info = formatInfoMessage(serverMessage)
              info.id = commandValue
              yield put({ type: StoryProgressActions.ADD_BACKPACK_INFO, info })
            }
          }
          break
        }
        // Show Web Command
        case 'show-web': {
          message.type = 'open-component'
          // Default title
          let buttonTitle = ''
          let content = serverMessage.content  // .replace(/\n/g, '')
          // Button Title is delivered in message-Field
          const pattern = new RegExp('<button>(.*)</button>', 'g')
          const regExpResult = pattern.exec(content)
          if (regExpResult) {
            buttonTitle = regExpResult[1]
          }
          message.custom = {
            ...message.custom,
            // Info-Content delievered by server in DS-Message
            content: commandValue,
            // Component to be opened on Tap
            component: 'web',
            buttonTitle: buttonTitle,
            infoId: commandValue
          }
          break
        }
        // Show Tour Command
        case 'show-tour': {
          message.type = 'open-component'
          // Button Title is delivered in message-Field
          let buttonTitle = (new RegExp('<button>(.*)</button>', 'g')).exec(serverMessage.content)[1]
          message.custom = {
            ...message.custom,
            // Component to be opened on Tap
            component: 'tour',
            buttonTitle: buttonTitle
          }
          break
        }
        // Show Backpack Command
        case 'show-backpack': {
          message.type = 'open-component'
          // Button Title is delivered in message-Field
          let buttonTitle = (new RegExp('<button>(.*)</button>', 'g')).exec(serverMessage.content)[1]
          message.custom = {
            ...message.custom,
            // Component to be opened on Tap
            component: 'backpack',
            buttonTitle: buttonTitle
          }
          break
        }
        // Show Backpack Command
        case 'show-diary': {
          message.type = 'open-component'
          // Button Title is delivered in message-Field
          let buttonTitle = (new RegExp('<button>(.*)</button>', 'g')).exec(serverMessage.content)[1]
          message.custom = {
            ...message.custom,
            // Component to be opened on Tap
            component: 'diary',
            buttonTitle: buttonTitle
          }
          break
        }
        // Show Backpack Command
        case 'show-pyramid': {
          message.type = 'open-component'
          // Button Title is delivered in message-Field
          let buttonTitle = (new RegExp('<button>(.*)</button>', 'g')).exec(serverMessage.content)[1]
          message.custom = {
            ...message.custom,
            // Component to be opened on Tap
            component: 'pyramid',
            buttonTitle: buttonTitle
          }
          break
        }
        // Other command not related to chat
        default:
          message.type = 'hidden-command'
          break
      }
      messages.push(message)
      break
    }
    default:
      log.warn('Received Deepstream Message with type: ' + serverMessage.type + ', but was ignored by ChatScreenComponent.')
      messages.push(message)
  }

  // Check if there should be any answer inputs displayed
  if (serverMessage['expects-answer']) {
    // Create Answer Message
    let inputMessage = {
      _id: serverMessage['client-id'] + '-' + subId++,
      user: {
        _id: 1
      },
      custom: {
        clientVersion: serverMessage['client-version'],
        clientStatus: serverMessage['client-status'],
        sticky: serverMessage['sticky'],
        visible: true
      }
    }
    // Check if there is an answer format
    if (serverMessage['answer-format']) {
      const { type, options } = serverMessage['answer-format']
      // Check the expected answer format
      switch (type) {
        case 'select-one': {
          inputMessage.type = 'select-one-button'
          let answers = []
          for (let i = 0; i < options.length; i++) {
            answers.push({
              button: options[i][0],
              value: options[i][1]
            })
          }
          inputMessage.custom = {
            ...inputMessage.custom,
            intention: 'answer-to-server-visible',
            selected: null,
            options: answers
          }
          break
        }
        case 'select-many': {
          inputMessage.type = 'select-many'
          let answers = []
          for (let j = 0; j < options.length; j++) {
            answers.push({
              label: options[j][0],
              value: options[j][1]
            })
          }
          inputMessage.custom = {
            ...inputMessage.custom,
            intention: 'answer-to-server-visible',
            options: answers
          }
          break
        }
        case 'likert': {
          inputMessage.type = 'likert'
          let answers = []
          for (let j = 0; j < options.length; j++) {
            answers.push({
              label: options[j][0],
              value: options[j][1]
            })
          }
          inputMessage.custom = {
            ...inputMessage.custom,
            intention: 'answer-to-server-visible',
            options: answers
          }
          break
        }
        case 'free-text':
        case 'free-text-multiline':
        case 'free-numbers':
          {
            let multiline = false
            let onlyNumbers = false
            let placeholder = null
            let textBefore = null
            let textAfter = null

            // Different types
            if (type === 'free-text') {
              inputMessage.type = 'free-text'
            } else if (type === 'free-text-multiline') {
              inputMessage.type = 'free-text'
              multiline = true
            } else if (type === 'free-numbers') {
              inputMessage.type = 'free-numbers'
              onlyNumbers = true
            }

            // Determine appropriate placeholders
            let placeholderText = ''
            if (options) placeholderText = options

            if (options.includes('_')) {
              let splitText = placeholderText.split(('_'), 2)
              if (splitText[0]) textBefore = splitText[0]
              if (splitText[1]) textAfter = splitText[1]
            } else if (placeholderText !== '') {
              placeholder = placeholderText
            }

            inputMessage.custom = {
              ...inputMessage.custom,
              intention: 'answer-to-server-visible',
              multiline,
              onlyNumbers,
              placeholder,
              textBefore,
              textAfter
            }
            break
          }
        case 'date':
        case 'time':
        case 'date-and-time': {
          inputMessage.type = 'date-input'
          let mode = 'datetime'
          if (type === 'date') mode = 'date'
          if (type === 'time') mode = 'time'
          let defaultOptions = {
            mode,
            placeholder: '',
            min: null,
            max: null
          }
          if (options[0][0]) defaultOptions.placeholder = options[0][0]
          if (options) {
            for (let j = 0; j < options.length; j++) {
              if (options[j][0] === 'min') {
                defaultOptions.min = options[j][1]
              } else if (options[j][0] === 'max') {
                defaultOptions.max = options[j][1]
              }
            }
          }
          inputMessage.custom = {
            ...inputMessage.custom,
            ...defaultOptions,
            intention: 'answer-to-server-visible'
          }
          break
        }
        case 'likert-slider': {
          inputMessage.type = 'likert-slider'
          let defaultOptions = {
            min: {
              label: 'Min',
              value: 0
            },
            max: {
              label: 'Max',
              value: 10
            }
          }
          if (options) {
            defaultOptions = {
              min: {
                label: options[0][0],
                value: Number(options[0][1])
              },
              max: {
                label: options[1][0],
                value: Number(options[1][1])
              }
            }
          }
          inputMessage.custom = {
            ...inputMessage.custom,
            ...defaultOptions,
            intention: 'answer-to-server-visible'
          }
          break
        }
      }
      messages.push(inputMessage)
      // Free-Text answer...
    } else {
      // Not implemented yet
    }
  }

  // Check for visibility-status
  messages.forEach((message) => {
    // Never render user-messages without text
    if (message.type === 'text' && message.text === '') {
      message.custom.visible = false
    }
    // Never render intentions without text => fancy ES6 syntax! :)
    if (message.type === 'intention' && ['', null, undefined].includes(message.text)) {
      message.custom.visible = false
    }
    // Never render hidden commands
    if (message.type === 'hidden-command') {
      message.custom.visible = false
    }
    // If message is answered don't render it
    if (message.type !== 'text' && (serverMessage['client-status'] === MessageStates.ANSWERED_ON_CLIENT || serverMessage['client-status'] === MessageStates.ANSWERED_AND_PROCESSED_BY_SERVER || serverMessage['client-status'] === MessageStates.NOT_ANSWERED_AND_PROCESSED_BY_SERVER)) {
      message.custom.visible = false
    }
  })

  return messages
}

function formatInfoMessage (serverMessage) {
  let content = serverMessage.content  // .replace(/\n/g, '')
  let parsedTags = new DOMParser().parseFromString(content, 'text/html')
  let meta = parsedTags.getElementsByTagName('meta')[0]
  let title = ''
  let subtitle = ''
  if (meta) {
    title = meta.getAttribute('title').replace('\\n', '\n')
    subtitle = meta.getAttribute('subtitle').replace('\\n', '\n')
  }

  // Remove Button
  const pattern = new RegExp('<button>(.*)</button>', 'g')
  const regExpResult = pattern.exec(content)
  if (regExpResult) {
    content = content.replace(regExpResult[0], '')
  }
  return {
    // Info-Content delievered by server in DS-Message
    content,
    // Component to be opened on Tap
    component: 'rich-text',
    title,
    subtitle,
    time: serverMessage['message-timestamp']
  }
}