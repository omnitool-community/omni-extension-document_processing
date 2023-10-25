/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

//@ts-check
import { createComponent, is_valid, sanitizeJSON, combineStringsWithoutOverlap, queryLlmByModelId, getLlmChoices, getModelMaxSize, getModelNameAndProviderFromId } from '../../../src/utils/omni-utils.js';
import { getChunksFromIndexAndIndexedDocuments, loadIndexes } from './omnilib-docs/vectorstore.js';
import { makeToast, sleep } from './omnilib-docs/toast.js';
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
        { name: 'temperature', type: 'number', defaultValue: 0 },
        { name: 'model_id', title: 'model', type: 'string', defaultValue: 'gpt-3.5-turbo-16k|openai', choices: llm_choices },
        { name: 'index', title: 'Read from Index:', type: 'string', description: "All indexed documents sharing the same Index will be grouped and queried together" },
        { name: 'context_size', type: 'number', defaultValue: 4096, choices: [0, 2048, 4096, 8192, 16384, 32768, 100000], description: "If set > 0, the size of the context window (in token) to use to process the query. If 0, try to use the model max_size automatically." },
        { name: 'llm_args', type: 'object', customSocket: 'object', description: 'Extra arguments provided to the LLM' },
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


    const indexed_documents = payload.indexed_documents;
    const index = payload.index;
    const all_indexes = await loadIndexes(ctx);

    const query = payload.query;
    const temperature = payload.temperature;
    const model_id = payload.model_id;
    let context_size = payload.context_size;
    const llm_args = payload.llm_args;

    let info = "";

    if (context_size == 0) 
    {
        const splits = getModelNameAndProviderFromId(model_id);
        const model_name = splits.model_name;
        context_size = getModelMaxSize(model_name, false) * 0.9;
    }
    const max_size = context_size * 0.9; // we use some margin
    info += `Using a max_size of ${max_size} tokens.  \n|`;

    const chunks = await getChunksFromIndexAndIndexedDocuments(ctx, all_indexes, index, indexed_documents);

    let chunk_index = 0;
    let total_token_cost = 0;
    let combined_text = "";
    const instruction = "Based on the user's prompt, answer the following question to the best of your abilities: " + query;
    const blocks = [];
    for (const chunk of chunks)
    {
        const is_last_index = (chunk_index == chunks.length - 1);

        const chunk_text = chunk?.text;
        const chunk_id = chunk?.id;

        const token_cost = chunk.token_count;
        const can_fit = (total_token_cost + token_cost <= max_size);

        if (can_fit)
        {
            combined_text = combineStringsWithoutOverlap(combined_text, chunk_text);
            total_token_cost += token_cost; // TBD: this is not accurate because we are not counting the tokens in the overlap or the instructions
            info += `Combining chunks.  chunk_id: ${chunk_id}, Token cost: ${total_token_cost}.  \n|`;
        }
        else
        {
            blocks.push(combined_text);
            combined_text = chunk_text;
            total_token_cost = token_cost;
        }

        if (is_last_index)
        {
            blocks.push(combined_text);
        }

        chunk_index += 1;
    }

    makeToast(ctx, `Processing ${blocks.length} blocks`);
    const promises = blocks.map((block_text, index) =>
        processBlock(ctx, block_text, instruction, model_id, temperature, llm_args, index + 1, blocks.length)
    );

    const llm_results = await Promise.all(promises);

    let answer = "";

    llm_results.forEach((partial_result, index) =>
    {
        const text = partial_result.text;
        if (text && text.length > 0)
        {
            answer += text + "   \n\n";
            info += `Answer: ${text}.  \n|`;
        }
    });

    const json = { 'answers': llm_results };

    const response = { result: { "ok": true }, answer, json, info };
    console.timeEnd("queryIndexBruteforce");

    return response;
}

async function processBlock(ctx, block_text, instruction, model_id, temperature, llm_args, block_index, block_count) {
    // Introduce a delay before making the request
    await sleep(1000 * block_index); // waits for block_index seconds
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