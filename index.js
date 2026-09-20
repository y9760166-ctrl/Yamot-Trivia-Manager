/**
 * =========================================================
 * מנוע API לניהול מודול טריוויה - 'ימות המשיח'
 * =========================================================
 */

const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// טוקן גישה ל-API של ימות המשיח (למחיקת קבצים)
const YEMOT_SYSTEM_TOKEN = process.env.YEMOT_TOKEN || "083136585:456987";

// נקודת הקצה הראשית עבור ימות המשיח
app.all('/api/trivia', async (req, res) => {
    try {
        const params = { ...req.query, ...req.body };

        const step = params.step || 'init';
        const qNum = parseInt(params.q_num) || 0;
        const itemType = params.item_type || ''; // 'question' / 'answer'
        const ansNum = parseInt(params.ans_num) || 0;
        const triviaFolder = params.trivia_folder || '1'; // נתיב שלוחת הטריוויה

        // חילוץ מבוקר של המקש שהוקש (מניעת ניתוקים)
        const dtmf = extractDTMF(params);

        // טעינת הגדרות השאלות והתשובות להיום
        const triviaData = getTodayTriviaConfig();

        if (!triviaData || !triviaData.questions || triviaData.questions.length === 0) {
            return sendYemotResponse(res, "id_list_message=t-לא נמצאו הקלטות טריוויה עבור היום. להתראות.&hangup=yes");
        }

        let responseText = "";

        // ניהול תפריטי השיחה (State Machine)
        switch (step) {
            case 'init':
            case 'select_question':
                responseText = handleSelectQuestion(dtmf, triviaData, triviaFolder);
                break;

            case 'select_item':
                responseText = handleSelectItem(dtmf, qNum, triviaData, triviaFolder);
                break;

            case 'action_menu':
                responseText = await handleActionMenu(dtmf, qNum, itemType, ansNum, triviaData, triviaFolder, params);
                break;

            case 'post_edit_menu':
                responseText = handlePostEditMenu(dtmf, qNum, triviaData, triviaFolder);
                break;

            default:
                responseText = handleSelectQuestion('', triviaData, triviaFolder);
                break;
        }

        return sendYemotResponse(res, responseText);

    } catch (error) {
        console.error("Error in Trivia API:", error);
        return sendYemotResponse(res, "id_list_message=t-אירעה שגיאה במערכת הניהול.&hangup=yes");
    }
});

// ==========================================
// לוגיקת התפריטים
// ==========================================

/**
 * שלב 1: בחירת שאלה לניהול
 */
function handleSelectQuestion(dtmf, triviaData, triviaFolder) {
    const totalQuestions = triviaData.questions.length;

    if (dtmf === '*') {
        return "id_list_message=t-תודה ושלום.&hangup=yes";
    }

    if (dtmf !== '') {
        const selectedQ = parseInt(dtmf);
        if (!isNaN(selectedQ) && selectedQ >= 1 && selectedQ <= totalQuestions) {
            return buildSelectItemPrompt(selectedQ, triviaData, triviaFolder);
        }
    }

    // הקראת מספרים מובנית של ימות המשיח (n-X)
    const promptList = [];
    promptList.push("t-נמצאו");
    promptList.push(`n-${totalQuestions}`);
    promptList.push("t-שאלות להיום. אנא בחרו את מספר השאלה לניהול");

    for (let i = 1; i <= totalQuestions; i++) {
        promptList.push("t-לשאלה");
        promptList.push(`n-${i}`);
        promptList.push("t-הקישו");
        promptList.push(`n-${i}`);
    }

    const promptStr = promptList.join(".");
    return responseRead(promptStr, "q_num", "digits", 1, 1, 7, "b", "1,2,3,4,5,6,7,8,9,*") +
           `&step=select_question&trivia_folder=${triviaFolder}`;
}

/**
 * שלב 2: בחירת הפריט לעריכה (השאלה עצמה או תשובה)
 */
function handleSelectItem(dtmf, qNum, triviaData, triviaFolder) {
    const question = triviaData.questions[qNum - 1];
    if (!question) return handleSelectQuestion('', triviaData, triviaFolder);

    if (dtmf === '*') {
        return handleSelectQuestion('', triviaData, triviaFolder);
    }

    const totalAnswers = question.answersCount;

    if (dtmf !== '') {
        const choice = parseInt(dtmf);
        if (choice === 0) {
            return buildActionMenuPrompt(qNum, 'question', 0, triviaFolder);
        } else if (!isNaN(choice) && choice >= 1 && choice <= totalAnswers) {
            return buildActionMenuPrompt(qNum, 'answer', choice, triviaFolder);
        }
    }

    return buildSelectItemPrompt(qNum, triviaData, triviaFolder);
}

function buildSelectItemPrompt(qNum, triviaData, triviaFolder) {
    const question = triviaData.questions[qNum - 1];
    const totalAnswers = question.answersCount;

    const promptList = [];
    promptList.push("t-שאלה מספר");
    promptList.push(`n-${qNum}`);
    promptList.push("t-בשאלה זו יש");
    promptList.push(`n-${totalAnswers}`);
    promptList.push("t-תשובות. לעריכת הקלטת השאלה הקישו");
    promptList.push("n-0");

    for (let i = 1; i <= totalAnswers; i++) {
        promptList.push("t-לעריכת תשובה");
        promptList.push(`n-${i}`);
        promptList.push("t-הקישו");
        promptList.push(`n-${i}`);
    }

    const promptStr = promptList.join(".");
    return responseRead(promptStr, "dtmf", "digits", 1, 1, 7, "b", "0,1,2,3,4,5,6,7,8,9,*") +
           `&step=select_item&q_num=${qNum}&trivia_folder=${triviaFolder}`;
}

/**
 * שלב 3: תפריט פעולות עריכה (הודעת M1009)
 */
async function handleActionMenu(dtmf, qNum, itemType, ansNum, triviaData, triviaFolder, params) {
    if (dtmf === '*') {
        return buildSelectItemPrompt(qNum, triviaData, triviaFolder);
    }

    const filePath = getTriviaFilePath(triviaFolder, qNum, itemType, ansNum);

    switch (dtmf) {
        case '1':
            // 1 - שמיעת ההקלטה משלוחת הטריוויה
            const playPrompt = `f-${filePath}.m-1009`;
            return responseRead(playPrompt, "dtmf", "digits", 1, 1, 7, "b", "1,2,3,4,*") +
                   `&step=action_menu&q_num=${qNum}&item_type=${itemType}&ans_num=${ansNum}&trivia_folder=${triviaFolder}`;

        case '2':
            // 2 - אישור ההקלטה -> מעבר לתפריט שאחרי עריכה
            return buildPostEditPrompt(qNum, triviaFolder);

        case '3':
            // 3 - הקלטה מחודשת ושמירה ישירה בשלוחת הטריוויה
            return responseRead("t-אנא הקליטו את ההודעה לאחר הצליל, בסיום הקישו סולמית", "rec_file", "voice", 1, 10, 60, "b", "#") +
                   `&save_file_path=${filePath}` +
                   `&step=post_edit_menu&q_num=${qNum}&trivia_folder=${triviaFolder}`;

        case '4':
            // 4 - מחיקת הקובץ משרתי ימות המשיח -> מעבר לתפריט שאחרי עריכה
            await deleteFileFromYemot(filePath);
            return responseRead("t-ההקלטה נמחקה בהצלחה." + getPostEditPromptText(), "dtmf", "digits", 1, 1, 7, "b", "1,2,3,*") +
                   `&step=post_edit_menu&q_num=${qNum}&trivia_folder=${triviaFolder}`;

        default:
            return buildActionMenuPrompt(qNum, itemType, ansNum, triviaFolder);
    }
}

function buildActionMenuPrompt(qNum, itemType, ansNum, triviaFolder) {
    return responseRead("m-1009", "dtmf", "digits", 1, 1, 7, "b", "1,2,3,4,*") +
           `&step=action_menu&q_num=${qNum}&item_type=${itemType}&ans_num=${ansNum}&trivia_folder=${triviaFolder}`;
}

/**
 * שלב 4: תפריט שאחרי עריכה
 */
function handlePostEditMenu(dtmf, qNum, triviaData, triviaFolder) {
    if (dtmf === '1') {
        return buildSelectItemPrompt(qNum, triviaData, triviaFolder);
    } else if (dtmf === '2') {
        return handleSelectQuestion('', triviaData, triviaFolder);
    } else if (dtmf === '3' || dtmf === '*') {
        return "id_list_message=t-תודה רבה. היציאה בוצעה בהצלחה.&hangup=yes";
    }

    return buildPostEditPrompt(qNum, triviaFolder);
}

function buildPostEditPrompt(qNum, triviaFolder) {
    return responseRead(getPostEditPromptText(), "dtmf", "digits", 1, 1, 7, "b", "1,2,3,*") +
           `&step=post_edit_menu&q_num=${qNum}&trivia_folder=${triviaFolder}`;
}

function getPostEditPromptText() {
    return "t-לעריכה נוספת בשאלה זו הקישו 1, לבחירת שאלה אחרת לניהול הקישו 2, ליציאה הקישו 3";
}

// ==========================================
// פונקציות עזר ותשתיות ימות המשיח
// ==========================================

function extractDTMF(params) {
    if (params.q_num) return params.q_num;
    if (params.dtmf) return params.dtmf;
    if (params.ApiDTMF) return params.ApiDTMF;
    return '';
}

function getTriviaFilePath(folder, qNum, itemType, ansNum) {
    const paddedQ = ("000" + qNum).slice(-3); // הופך ל-001, 002...
    if (itemType === 'question') {
        return `${folder}/${paddedQ}.wav`;
    } else {
        return `${folder}/${paddedQ}_${ansNum}.wav`;
    }
}

async function deleteFileFromYemot(filePath) {
    try {
        const url = `https://www.call2all.co.il/ym/api/DeleteFile?token=${encodeURIComponent(YEMOT_SYSTEM_TOKEN)}&what=${encodeURIComponent("ivar:/" + filePath)}`;
        await axios.get(url);
    } catch (e) {
        // התעלמות אם הקובץ לא היה קיים
    }
}

function responseRead(messages, valName, type, min, max, timeout, tap, validDigits) {
    return `id_list_message=${messages}` +
           `&read=${messages}=${valName},${type},${min},${max},${timeout},${tap},no,${validDigits}`;
}

function sendYemotResponse(res, bodyText) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(bodyText);
}

function getTodayTriviaConfig() {
    return {
        questions: [
            { id: 1, answersCount: 3 },
            { id: 2, answersCount: 3 },
            { id: 3, answersCount: 4 }
        ]
    };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Trivia Management API Server is running on port ${PORT}`);
});
