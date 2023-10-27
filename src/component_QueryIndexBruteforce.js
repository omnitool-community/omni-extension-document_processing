/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

//@ts-check
import { createComponent, sanitizeJSON, queryLlmByModelId, getLlmChoices } from '../../../src/utils/omni-utils.js';
import { createChunkBlocks } from './omnilib-docs/chunking.js';
import { getChunksFromIndexAndIndexedDocuments } from './omnilib-docs/vectorstore.js';
import { makeToast, sleep, getModelMaxSizeFromModelId, } from './omnilib-docs/utilities.js';
const NAMESPACE = 'document_processing';;
const OPERATION_ID = 'query_index_bruteforce';
const TITLE = 'Query Index (Brute Force)';
const DESCRIPTION = 'Run a LLM on an array of documents, one fragment at a time, and return the results in an array';
const SUMMARY = DESCRIPTION;
const CATEGORY = 'document processing';


async function async_getQueryIndexBruteforceComponent()
{

    const llm_choices = await getLlmChoices();

    const links = {};

    const inputs = [
        { name: 'indexed_documents', type: 'array', customSocket: 'documentArray', description: 'Documents to be processed' },
        { name: 'query', type: 'string', description: 'The query', customSocket: 'text' },
        { name: "temperature", type: "number", defaultValue: 0, minimum: 0, maximum: 1, step: 0.1, description: "The temperature to use for the LLM" },
        { name: 'model_id', title: 'model', type: 'string', defaultValue: 'gpt-3.5-turbo-16k|openai', choices: llm_choices },
        { name: 'index', title: 'Read from Index:', type: 'string', description: "All indexed documents sharing the same Index will be grouped and queried together" },
        { name: 'context_size', type: 'number', defaultValue: 4096, choices: [0, 2048, 4096, 8192, 16384, 32768, 100000], description: "If set > 0, the size of the context window (in token) to use to process the query. If 0, try to use the model max_size automatically." },
        { name: 'llm_args', type: 'object', customSocket: 'object', description: 'Extra arguments provided to the LLM' },
        { name: 'tokens_per_minutes', type: 'number', defaultValue: 40000, minimum:0, maximum: 200000, description: "If set > 0, the TPM (token per minute) limit. Useful for openai and other services with rate limits. 0 disable this rate limitation." },
        { name: 'requests_per_minutes', type: 'number', defaultValue: 500, minimum:0, maximum: 200000, description: "If set > 0, the RPM (request per minute) limit. Useful for openai and other services with rate limits. 0 disable this rate limitation. DO NOT USE openai endpoints at the same time as this recipe for this to be accurate." },
    ];

    const outputs = [
        { name: 'answer', type: 'string', customSocket: 'text', description: 'The answer to the query or prompt', title: 'Answer' },
        { name: 'json', type: 'object', customSocket: 'object', description: 'The answer in json format, with possibly extra arguments returned by the LLM', title: 'Json' },
        { name: 'info', type: 'string', customSocket: 'text', description: "Information about the block's operation" },
    ];
    const controls = null;

    const component = createComponent(NAMESPACE, OPERATION_ID, TITLE, CATEGORY, DESCRIPTION, SUMMARY, links, inputs, outputs, controls, queryIndexBruteforce);
    return component;

}

async function queryIndexBruteforce(payload, ctx)
{
    console.time("queryIndexBruteforce");
    let info = "queryIndexBruteforce.\n|";

    let max_tokens_per_minutes = payload.tokens_per_minutes;
    let max_requests_per_minutes = payload.requests_per_minutes;
    if (!max_tokens_per_minutes || max_tokens_per_minutes <= 0) 
    {
        max_tokens_per_minutes = Number.MAX_SAFE_INTEGER;
        info += `No token limit.  \n|`;
    }
    if (!max_requests_per_minutes || max_requests_per_minutes <= 0) 
    {
        max_requests_per_minutes = Number.MAX_SAFE_INTEGER;
        info += `No request limit.  \n|`;
    }

    let tokensUsed = 0;
    let queriesMade = 0;
    let startTime = Date.now();

    const indexed_documents = payload.indexed_documents;
    const index = payload.index;

    const query = payload.query;
    const temperature = payload.temperature;
    const model_id = payload.model_id;
    let context_size = payload.context_size;
    const llm_args = payload.llm_args;

    const max_size = getModelMaxSizeFromModelId(context_size, model_id);
    info += `Using a max_size of ${max_size} tokens.  \n|`;
  
    const all_chunks = await getChunksFromIndexAndIndexedDocuments(ctx, index, indexed_documents);
    const blocks_result = await createChunkBlocks(ctx, max_size, all_chunks, info);
    const blocks = blocks_result.blocks;
    info += blocks_result.info;

    const instruction = "Based on the user's prompt, answer the following question to the best of your abilities: " + query;
    //const promises = [];
    const llm_results = [];

    for (let block_index = 0; block_index < blocks.length; block_index++) {
        const block = blocks[block_index];
        const block_token_cost = block.token_cost * 1.2; // we use some margin due to other tokens in the instruction
        const block_text = block.text;

        // Check if the next query will exceed the budgets
        if (tokensUsed + block_token_cost > max_tokens_per_minutes || queriesMade + 1 > max_requests_per_minutes) {
            // Calculate how much time to wait before making the next query
            let timePassed = Date.now() - startTime;
            let timeToWait = 60000 - timePassed; // Wait for the remainder of the minute
            await sleep(timeToWait);

            // Reset tracking variables
            tokensUsed = 0;
            queriesMade = 0;
            startTime = Date.now();
        }

        // Proceed with the query
        const llm_result = await processBlock(ctx, block_text, instruction, model_id, temperature, llm_args, block_index + 1, blocks.length);
        llm_results.push(llm_result);
        
        // Update tracking variables
        tokensUsed += block_token_cost;
        queriesMade++;
    }

    //const llm_results = await Promise.all(promises);
    //llm_results.forEach((partial_result, index) =>

    let answer = "";
    for (const partial_result of llm_results)
    {
        const text = partial_result.text;
        if (text && text.length > 0)
        {
            answer += text + "   \n\n";
            info += `Answer: ${text}.  \n|`;
        }
    }

    const json = { 'answers': llm_results };

    const response = { result: { "ok": true }, answer, json, info };
    console.timeEnd("queryIndexBruteforce");

    return response;
}

async function processBlock(ctx, block_text, instruction, model_id, temperature, llm_args, block_index, block_count) {
    // Introduce a delay before making the request
    makeToast(ctx, `Queuing up Block #${block_index}/${block_count}`);

    const results = await queryLlmByModelId(ctx, block_text, instruction, model_id, temperature, llm_args);
    const sanetized_results = sanitizeJSON(results);
    const text = sanetized_results?.answer_text || "";
    const function_arguments_string = sanetized_results?.answer_json?.function_arguments_string; 
    const function_arguments = sanetized_results?.answer_json?.function_arguments;

    makeToast(ctx, `### Received answer for Block ${block_index}/${block_count}  \n\n${text}`);

    return { text, function_arguments_string, function_arguments };
}



export { async_getQueryIndexBruteforceComponent, queryIndexBruteforce };