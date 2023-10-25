export function makeToast(ctx, message)
{
    const app = ctx.app;
    const user = ctx.userId;
    const description_json = { type: "info", description: `Chunking document progress` };
    const toast = { user, message, description_json };
    app.sendToastToUser(user, toast);
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}