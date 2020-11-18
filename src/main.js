/*
    Main entry point for the bot.
*/

// Dependencies
const botcore = require("messenger-botcore"); // Common bot code
const config = require("./config"); // Config file
const utils = require("./utils"); // Utility functions
const commands = require("./commands"); // Command documentation/configuration
const runner = require("./runcommand"); // For command handling code
require("./server"); // Server configuration (just needs to be loaded)
const easter = require("./easter"); // Easter eggs
const passive = require("./passive"); // Passive messages
let credentials;
try {
    // Login creds from local dir
    credentials = require("./credentials");
} catch (e) {
    // Deployed to Heroku or config file is missing
    credentials = process.env;
}
// External storage API (Memcachier) (requires credentials)
const mem = require("memjs").Client.create(credentials.MEMCACHIER_SERVERS, {
    "username": credentials.MEMCACHIER_USERNAME,
    "password": credentials.MEMCACHIER_PASSWORD
});
var gapi; // Global API for external functions (set on login)
var stopListening; // Global function to call to halt the listening process

// Log in
if (require.main === module) { // Called directly; login immediately
    console.log(`Bot ${config.bot.id} logging in ${process.env.FACEBOOK_EMAIL ? "remotely" : "locally"} with trigger "${config.trigger}".`);
    botcore.login.login(credentials, main);
}

// Bot setup
function main(err, api) {
    if (err) return console.error(err);
    console.info(`Successfully logged in to user account ${api.getCurrentUserID()}.`);
    gapi = api; // Initialize global API variable
    utils.setglobals(api, mem, credentials); // Initialize in utils module as well

    // Configure the instance
    botcore.monitoring.monitor(api, config.owner.id, config.bot.names.short, credentials, process, newApi => {
        // Called when login failed and a new retried login was successful
        stopListening();
        gapi = newApi;
        utils.setglobals(gapi, mem, credentials);
        stopListening = newApi.listenMqtt(handleMessage);
    });
    api.setOptions({ listenEvents: true });

    // Kick off the message handler
    stopListening = api.listenMqtt(handleMessage);
    // Kick off the event handler
    setInterval(eventLoop, config.eventCheckInterval * 60000);

    // Tell process manager that this process is ready
    process.send ? process.send("ready") : null;
}

// Processes incoming messages
// Passed as callback to API's listen, but can also be called externally
// (function is exported as a part of this module)
function handleMessage(err, message, external = false, api = gapi) { // New message received from listen()
    if (message && message.threadID && !err) {
        // Update info of group where message came from in the background (unless it's an external call)
        if (!external && (message.type == "message" || message.type == "event")) {
            utils.updateGroupInfo(message.threadID, message);
        }
        // Load existing group data
        utils.getGroupInfo(message.threadID, (err, info) => {
            if (err || !info) {
                console.log(`Error retrieving group data for ${message.threadID}: ${err}`);
            } else {
                // Welcome new members
                if (message.logMessageType && message.logMessageType == "log:subscribe") {
                    const newMembers = message.logMessageData.addedParticipants.filter(m => m.userFbId != config.bot.id);
                    if (newMembers.length > 0) {
                        const names = newMembers.map(mem => mem.firstName).join("/");
                        utils.welcomeToChat(names, info);
                    }
                }

                // Handle messages
                const senderId = message.senderID;
                botcore.banned.isUser(senderId, isBanned => {
                    if ((message.type == "message" || message.type == "message_reply") && senderId != config.bot.id && !isBanned) { // Sender is not banned and is not the bot
                        const m = message.body;
                        const attachments = message.attachments;
                        // Handle message body
                        if (m) {
                            // Pass to commands testing for trigger word
                            const cindex = m.toLowerCase().indexOf(config.trigger);
                            if (cindex > -1) { // Trigger command mode
                                // Also pass full message obj in case it's needed in a command
                                handleCommand(m.substring(cindex + config.trigger.length + 1), senderId, info, message);
                            }

                            // Check for Easter eggs
                            easter.handleEasterEggs(message, senderId, attachments, info, api);

                            // Check for passive messages to expand rich content
                            passive.handlePassive(message, info, api);
                        }
                    } else if (message.type == "message_reaction") { // Potential event response
                        const eventMidMap = Object.keys(info.events).reduce((events, e) => {
                            const event = info.events[e];
                            events[event.mid] = event;
                            return events;
                        }, {});

                        const event = eventMidMap[message.messageID];
                        const rsvpr = message.userID;
                        const resp = message.reaction;
                        if (event && (resp == "👍" || resp == "👎")) {
                            api.getUserInfo(rsvpr, (err, uinfo) => {
                                if (!err) {
                                    const data = uinfo[rsvpr];
                                    let resp_list;

                                    // Remove any pre-existing responses from that user
                                    event.going = event.going.filter(user => user.id != rsvpr);
                                    event.not_going = event.not_going.filter(user => user.id != rsvpr);

                                    if (resp == "👍") {
                                        resp_list = event.going;
                                    } else if (resp == "👎") {
                                        resp_list = event.not_going;
                                    } else {
                                        // Not a valid RSVP react
                                        return;
                                    }

                                    resp_list.push({
                                        "id": rsvpr,
                                        "name": data.firstName
                                    });
                                    utils.setGroupProperty("events", info.events, info);
                                }
                            });
                        }
                    }
                });
            }
        });
    }
}
exports.handleMessage = handleMessage;

/*
  This is the main body of the bot; it handles whatever comes after the trigger word
  in the received message body and looks for matches of commands listed in the commands.js
  file, and then processes them accordingly.
*/
function handleCommand(command, fromUserId, groupInfo, messageLiteral, api = gapi) {
    const attachments = messageLiteral.attachments; // For commands that take attachments
    // Command preprocessing to compare command grammars against input and check for matches
    const co = commands.commands; // Short var names since I'll be typing them a lot
    for (let c in co) {
        if (co.hasOwnProperty(c)) {
            // Check whether command is sudo-protected and, if so, whether the user is the owner
            if (!co[c].sudo || (co[c].sudo && fromUserId == config.owner.id)) {
                // Set match vals
                // fromStart will concatenate a 'start of string' operator to the beginning
                // of the regular expression used to match commands if contextless grammar
                // is turned off in the config (off by default)
                let regex = Array.isArray(co[c].regex) ? co[c].regex[0] : co[c].regex;
                if (typeof regex == "string") { regex = new RegExp(regex); }
                const fromStart = config.contextless ? regex : new RegExp("^" + regex.source, regex.flags);
                if (co[c].user_input.accepts) { // Takes a match from the members dict
                    if (Array.isArray(co[c].regex)) { // Also has a regex suffix (passed as length 2 array)
                        co[c].m = utils.matchesWithUser(fromStart, command, fromUserId, groupInfo, co[c].user_input.optional, " ", co[c].regex[1]);
                    } else { // Just a standard regex prefex as a string + name
                        co[c].m = utils.matchesWithUser(fromStart, command, fromUserId, groupInfo, co[c].user_input.optional);
                    }
                } else {
                    co[c].m = command.match(fromStart);
                }
            } else { // User not authorized
                // Set match to null to prevent checking issues
                co[c].m = null;
            }
            // Update usage statistics if command is matched
            if (co[c].m) {
                utils.updateStats(c, fromUserId);
            }
        }
    }
    debugCommandOutput(false);
    // Check commands for matches & eval
    runner.run(api, co, groupInfo, fromUserId, attachments, messageLiteral);
}
exports.handleCommand = handleCommand; // Export for external use

function debugCommandOutput(flag) {
    if (flag) {
        const co = commands.commands;
        console.log(Object.keys(co).map(c => {
            return `${c}: ${co[c].m}`;
        }));
    }
}

function eventLoop() {
    utils.getGroupData((err, data) => {
        if (!err) {
            // Collect events from all of the groups
            let events = Object.keys(data).reduce((events, group) => {
                const gEvents = data[group].events;
                Object.keys(gEvents).forEach(event => {
                    events.push(gEvents[event]);
                });

                return events;
            }, []);

            const curTime = new Date();
            events.forEach(event => {
                if (new Date(event.timestamp) <= curTime
                    || (event.remind_time && new Date(event.remind_time) <= curTime)) {
                    // Event is occurring! (or occurred since last check)
                    let msg, mentions, replyId;
                    if (event.type == "event") {
                        // Event
                        msg = `Happening ${event.remind_time ? `in ${config.reminderTime} minutes` : "now"}: ${event.title}${event.going.length > 0 ? "\n\nReminder for " : ""}`;

                        // Build up mentions string (with Oxford comma 🤘)
                        let numGoing = event.going.length;
                        event.going.forEach((user, i) => {
                            if (i < numGoing - 1 || numGoing == 1) {
                                msg += `@${user.name}`;
                                if (numGoing > 2) {
                                    msg += ", ";
                                } else {
                                    msg += " ";
                                }
                            } else {
                                msg += `and @${user.name}`;
                            }
                        });
                        mentions = event.going.map(user => {
                            return {
                                "tag": `@${user.name}`,
                                "id": user.id
                            };
                        });
                    } else {
                        // Reminder
                        msg = `Reminder for @${event.owner_name}: ${event.reminder}`;
                        mentions = [{
                            "tag": `@${event.owner_name}`,
                            "id": event.owner
                        }];
                        replyId = event.replyId;
                    }

                    // Send off the reminder message and delete the event
                    const groupInfo = data[event.threadId];
                    utils.sendMessageWithMentions(msg, mentions, groupInfo.threadId, replyId);

                    if (event.remind_time) {
                        // Don't delete, but don't remind again
                        groupInfo.events[event.key_title].remind_time = null;
                        utils.setGroupProperty("events", groupInfo.events, groupInfo);
                    } else {
                        utils.deleteEvent(event.key_title, event.owner, groupInfo, groupInfo.threadId, false);
                    }
                }
            });
        }
    });
}