
import { getModelMaxSize, getModelNameAndProviderFromId } from '../../../../src/utils/omni-utils.js';
const CONTEXT_SAFETY_MARGIN = 0.9;

function makeToast(ctx, message)
{
    const app = ctx.app;
    const user = ctx.userId;
    const description_json = { type: "info", description: `Chunking document progress` };
    const toast = { user, message, description_json };
    app.sendToastToUser(user, toast);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getModelMaxSizeFromModelId(context_size, model_id)
{
    let max_size = 0;
    if (context_size == 0)
    {
        const splits = getModelNameAndProviderFromId(model_id);
        const model_name = splits.model_name;
        max_size = getModelMaxSize(model_name, false) * CONTEXT_SAFETY_MARGIN;
    }
    else
    {
        max_size = context_size * CONTEXT_SAFETY_MARGIN;
    }

    return max_size;
}


export {makeToast, sleep, getModelMaxSizeFromModelId };

// -------------------------------------
