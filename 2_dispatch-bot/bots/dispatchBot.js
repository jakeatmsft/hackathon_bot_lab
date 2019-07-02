// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { ActivityHandler, ActionTypes, CardFactory, MessageFactory } = require('botbuilder');
const { TranslationSettings } = require('../translation/translationSettings');

const englishEnglish = TranslationSettings.englishEnglish;
const englishSpanish = TranslationSettings.englishSpanish;
const spanishEnglish = TranslationSettings.spanishEnglish;
const spanishSpanish = TranslationSettings.spanishSpanish;

const { LuisRecognizer, QnAMaker } = require('botbuilder-ai');

class DispatchBot extends ActivityHandler {
    /**
     * Creates a Multilingual bot.
     * @param {Object} userState User state object.
     * @param {Object} languagePreferenceProperty Accessor for language preference property in the user state.
     * @param {any} logger object for logging events, defaults to console if none is provided
     * @param {any} translator
     */
    constructor(userState, languagePreferenceProperty, logger, translator) {
        super();
        if (!userState) {
            throw new Error('[MultilingualBot]: Missing parameter. userState is required');
        }
        if (!languagePreferenceProperty) {
            throw new Error('[MultilingualBot]: Missing parameter. languagePreferenceProperty is required');
        }
        if (!logger) {
            logger = console;
            logger.log('[MultilingualBot]: logger not passed in, defaulting to console');
        }
        if (!translator) {
            throw new Error('[MultilingualBot]: Missing parameter. translator is required');
        }

        this.userState = userState;
        this.languagePreferenceProperty = languagePreferenceProperty;
        this.logger = logger;
        this.translator = translator;

        const dispatchRecognizer = new LuisRecognizer({
            applicationId: process.env.LuisAppId,
            endpointKey: process.env.LuisAPIKey,
            endpoint: `https://${ process.env.LuisAPIHostName }.api.cognitive.microsoft.com`
        }, {
            includeAllIntents: true,
            includeInstanceData: true
        }, true);

        const qnaMaker = new QnAMaker({
            knowledgeBaseId: process.env.QnAKnowledgebaseId,
            endpointKey: process.env.QnAAuthKey,
            host: process.env.QnAEndpointHostName
        });

        this.logger = logger;
        this.dispatchRecognizer = dispatchRecognizer;
        this.qnaMaker = qnaMaker;

        this.onMessage(async (context, next) => {
            this.logger.log('Processing Message Activity.');
            if (isLanguageChangeRequested(context.activity.text)) {
                const currentLang = context.activity.text.toLowerCase();
                const lang = currentLang === englishEnglish || currentLang === spanishEnglish ? englishEnglish : englishSpanish;

                // Get the user language preference from the user state.
                await this.languagePreferenceProperty.set(context, lang);

                // If the user requested a language change through the suggested actions with values "es" or "en",
                // simply change the user's language preference in the user state.
                // The translation middleware will catch this setting and translate both ways to the user's
                // selected language.
                // If Spanish was selected by the user, the reply below will actually be shown in spanish to the user.
                await context.sendActivity(`Your current language code is: ${ lang }`);
                
                await this.userState.saveChanges(context);
            } else {
                // If language preference is Spanish, translate input spanish text to english, 
                // Then pass english translation to Dispatcher for LUIS/QnA recognition
                const currentLang = await this.languagePreferenceProperty.get(context);
                this.logger.log('getting locale: '+  currentLang);
                if(currentLang == "es") {
                    var translatedText = await this.translator.translate(context.activity.text, "en");
                    context.activity.text = translatedText;
                }

                // First, we use the dispatch model to determine which cognitive service (LUIS or QnA) to use.
                const recognizerResult = await dispatchRecognizer.recognize(context);

                // Top intent tell us which cognitive service to use.
                const intent = LuisRecognizer.topIntent(recognizerResult);

                // Next, we call the dispatcher with the top intent.
                await this.dispatchToTopIntentAsync(context, intent, recognizerResult);
                await next();
            }
            
        });

        this.onMembersAdded(async (context, next) => {
            const welcomeText = 'Type a greeting or a question about the weather to get started. \nYour current language is English (en), to change to spanish type \'es\'.';
            const membersAdded = context.activity.membersAdded;

            for (let member of membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(`Welcome to Dispatch bot ${ member.name }. ${ welcomeText }`);
                }
            }

            // By calling next() you ensure that the next BotHandler is run.
            await next();
        });
    }

    async dispatchToTopIntentAsync(context, intent, recognizerResult) {
        switch (intent) {
        case 'l_Weather':
            await this.processWeather(context, recognizerResult.luisResult);
            break;
        case 'q_sample-qna':
            await this.processSampleQnA(context);
            break;
        default:
            this.logger.log(`Dispatch unrecognized intent: ${ intent }.`);
            await context.sendActivity(`Dispatch unrecognized intent: ${ intent }.`);
            break;
        }
    }

    async processWeather(context, luisResult) {
        this.logger.log('processWeather');

        // Retrieve LUIS results for Weather.
        const result = luisResult.connectedServiceResult;
        const topIntent = result.topScoringIntent.intent;

        await context.sendActivity(`ProcessWeather top intent ${ topIntent }.`);
        //await context.sendActivity(`ProcessWeather intents detected:  ${ luisResult.intents.map((intentObj) => intentObj.intent).join('\n\n') }.`);

        if (luisResult.entities.length > 0) {
            await context.sendActivity(`ProcessWeather entities were found in the message: ${ luisResult.entities.map((entityObj) => entityObj.entity).join('\n\n') }.`);
        }
    }

    async processSampleQnA(context) {
        this.logger.log('processSampleQnA');

        const results = await this.qnaMaker.getAnswers(context);

        if (results.length > 0) {
            await context.sendActivity(`${ results[0].answer }`);
        } else {
            await context.sendActivity('Sorry, could not find an answer in the Q and A system.');
        }
    }
}
/**
 * Checks whether the utterance from the user is requesting a language change.
 * In a production bot, we would use the Microsoft Text Translation API language
 * detection feature, along with detecting language names.
 * For the purpose of the sample, we just assume that the user requests language
 * changes by responding with the language code through the suggested action presented
 * above or by typing it.
 * @param {string} utterance the current turn utterance.
 */
function isLanguageChangeRequested(utterance) {
    // If the utterance is empty or the utterance is not a supported language code,
    // then there is no language change requested
    if (!utterance) {
        return false;
    }

    // We know that the utterance is a language code. If the code sent in the utterance
    // is different from the current language, then a change was indeed requested
    utterance = utterance.toLowerCase().trim();
    return utterance === englishSpanish || utterance === englishEnglish || utterance === spanishSpanish || utterance === spanishEnglish;
}
module.exports.DispatchBot = DispatchBot;
