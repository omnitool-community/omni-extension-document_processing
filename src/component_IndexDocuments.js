/**
 * Copyright (c) 2023 MERCENARIES.AI PTE. LTD.
 * All rights reserved.
 */

//@ts-check
import { createComponent, countTokens as countTokensFunction, downloadTextsFromCdn, getLlmChoices } from '../../../src/utils/omni-utils.js';

import { initialize_hasher, computeDocumentId } from './omnilib-docs/hashers.js';
import { initializeSplitter, getSplitterChoices, SPLITTER_MODEL_TOKEN } from './omnilib-docs/splitter.js';
import { initializeEmbedder } from './omnilib-docs/embeddings.js';
import { chunkText, uploadTextWithCaching } from './omnilib-docs/chunking.js';
import { DEFAULT_HASHER_MODEL } from './omnilib-docs/hashers.js';
import { DEFAULT_SPLITTER_MODEL } from './omnilib-docs/splitter.js';
import { DEFAULT_OVERLAP_PERCENT, DEFAULT_FRAGMENT_SIZE, saveIndexedDocument, computeCharacterToTokenRatio } from './omnilib-docs/chunking.js';
import { loadIndexes, addCdnToIndex as addCdnToIndex, saveIndexes, getIndexedDocumentCdnFromId, getIndexedDocumentInfoFromCdn } from './omnilib-docs/vectorstore.js';
import { chunk } from 'lodash-es';
 
async function async_getIndexComponent()
{

    const NAMESPACE = 'document_processing';
    const OPERATION_ID = "index_documents";
    const TITLE = 'Index documents'
    const DESCRIPTION = 'Index document(s), chunking them and computing the embedding for each chunk'
    const SUMMARY = 'Index document(s), chunking them and computing the embedding for each chunk'
    const CATEGORY = 'document processing'

    const llm_choices = await getLlmChoices();

    const inputs = [
        { name: 'documents', title: 'Documents to index', type: 'array', customSocket: 'documentArray', description: 'Documents to be indexed', allowMultiple: true },
        { name: 'text', type: 'string', title: 'Text to index', customSocket: 'text', description: 'And/or some Text to be indexed directly', allowMultiple: true  },
        { name: 'splitter_model', type: 'string', defaultValue: 'RecursiveCharacterTextSplitter', title: "Splitter Model", description: "Choosing a splitter model that matches the type of document being indexed will produce the best results", choices: getSplitterChoices()},
        { name: 'fragment_size', type: 'number', defaultValue: 8192, minimum: 0, maximum:131072, step:1024, description: "Approximate size of the fragments, in tokens." },
        { name: 'overlap_percent', type: 'number', defaultValue: .50, minimum: 0, maximum:1, step:0.05, description: "Approximate size of the overlap between fragments, in percentage. Default is .5 (50%)" },
        { name: 'overwrite', type: 'boolean', defaultValue: false, description: "If set to true, will overwrite existing matching documents" },
        { name: 'index', title: 'Save to Index:', type: 'string', description: "All indexed documents sharing the same index will be grouped and queried together"},
        { name: 'characters_to_tokens_ratio', type: 'number', defaultValue: 4.7, minimum: 0, maximum:20, step:0.1, description: "how many characters per token, in average" },
    ];

    const outputs = [
        { name: 'info', type: 'string', customSocket: "text", description: 'Info on the result of the indexation'},
        { name: 'index', type: 'string', customSocket: "text", description: 'The name of the index that was created or updated' },
        { name: 'documents', title: "Indexed Documents", type: 'array', customSocket: 'documentArray', description: 'The indexed version of the documents' },
    ];

    const links = {};

    const controls = null;

    const IndexDocumentsComponent = createComponent(NAMESPACE, OPERATION_ID,TITLE, CATEGORY, DESCRIPTION, SUMMARY, links, inputs, outputs, controls, indexDocuments_function );
    return IndexDocumentsComponent;
}

async function indexDocuments_function(payload, ctx)
{
    console.time("indexDocuments_function");

    const hasher_model = DEFAULT_HASHER_MODEL;

    let info = "";
    const documents_cdns = payload.documents || []
    const text = payload.text;
    const overwrite = payload.overwrite || false;
    const splitter_model = payload.splitter_model || DEFAULT_SPLITTER_MODEL;
    const overlap_percent = payload.overlap_percent || DEFAULT_OVERLAP_PERCENT;
    let fragment_size = payload.fragment_size || DEFAULT_FRAGMENT_SIZE;
    const index = payload.index || "";
    let characters_to_tokens_ratio = payload.characters_to_tokens_ratio; 

    if (fragment_size == 0)
    {
        fragment_size = 2048; // a somewhat safe assumption as it works with most models
    }
    let chunk_size = Math.floor( fragment_size / (1 + overlap_percent) ) * 0.9; // taking a 10% margin
    // the fragment must contain the chunk size, plus the overlap. So F = (C + C*overlap_percent); or C = F/(1+overlap_percent)

    if (characters_to_tokens_ratio == 0) characters_to_tokens_ratio = 4.7;
    
    let chunk_overlap = Math.floor(chunk_size * overlap_percent);
    if (chunk_overlap < 0) throw new Error(`ERROR: chunk_overlap < 0`);
    if (chunk_overlap >= chunk_size) throw new Error(`ERROR: chunk_overlap >= chunk_size`);
    if (chunk_size <= 0) throw new Error(`ERROR: chunk_size <= 0`);
    if (characters_to_tokens_ratio <= 0) throw new Error(`ERROR: characters_to_tokens_ratio <= 0`);

    const hasher = initialize_hasher(hasher_model);

    if (splitter_model != SPLITTER_MODEL_TOKEN) 
    {
        // other splitters use characters instead of tokens
        const old_chunk_size = chunk_size;
        chunk_size = Math.floor(old_chunk_size * characters_to_tokens_ratio);
        chunk_overlap = Math.floor(old_chunk_size * overlap_percent * characters_to_tokens_ratio);

        info += `Splitter is not token based. Based on characters_to_tokens_ratio = ${characters_to_tokens_ratio}, adjusting chunk_size to ${chunk_size} and chunk_overlap to ${chunk_overlap} \n`;
    }
    else
    {
        info += `Splitter is token based. chunk_size = ${chunk_size} and chunk_overlap = ${chunk_overlap} \n`;
    }
    
    const splitter = initializeSplitter(splitter_model, chunk_size, chunk_overlap);
    const embedder = await initializeEmbedder(ctx);
    const all_indexes = await loadIndexes(ctx);
    
    // --------------- UPLOAD if needed----------------
    if (text && text.length > 0) 
    {
        const text_cdn = await uploadTextWithCaching(ctx, text, hasher, chunk_size, chunk_overlap, overwrite);
        if (!text_cdn) throw new Error(`ERROR: could not upload Text to CDN`);
        documents_cdns.push(text_cdn);
        info += `Uploaded text to CDN with fid ${text_cdn.fid} \n`;
    }

    if (!documents_cdns|| documents_cdns.length == 0) throw new Error(`ERROR: no documents passed for ingestion`); 
    const documents_texts = await downloadTextsFromCdn(ctx, documents_cdns); 

    let all_chunks = [];
    let all_cdns = [];
    let document_number = 0;
    for (const document_text of documents_texts)
    {
        let indexed_document_chunks = null;
        const document_id = computeDocumentId(ctx, [document_text], hasher, chunk_size, chunk_overlap);
        if (!document_id) throw new Error(`ERROR: could not compute document_id for document #${document_number}, id:${document_id}`);

        let indexed_document_cdn = await getIndexedDocumentCdnFromId(ctx, document_id, overwrite);
        if (!indexed_document_cdn)
        {
            indexed_document_chunks = await chunkText(ctx, document_id, document_text, hasher, embedder, splitter, countTokensFunction);
            if (!indexed_document_chunks) throw new Error(`ERROR: could not chunk text in document #${document_number}, id:${document_id}`);
    
            // compute token_to_character_ratio. This is somewhat optional, but it is useful to know the rough ratio of tokens to chunking size
            const ratio = computeCharacterToTokenRatio(indexed_document_chunks);
            info += `Actual CharacterToToken Ratio = ${ratio} \n`;
            indexed_document_cdn = await saveIndexedDocument(ctx, document_id, indexed_document_chunks, chunk_size, chunk_overlap, ratio, splitter_model);
        }
        else
        {
            const document_info = await getIndexedDocumentInfoFromCdn(ctx, indexed_document_cdn);
            if (!document_info) throw new Error(`ERROR: could not get document_info from cdn ${JSON.stringify(indexed_document_cdn)}`);

            indexed_document_chunks = document_info.chunks;
            if (!indexed_document_chunks) throw new Error(`ERROR: could not get chunks from document_info = ${JSON.stringify(document_info)} from cdn ${JSON.stringify(indexed_document_cdn)}`);
        }
        
        if (!indexed_document_cdn) throw new Error(`ERROR: could not chunk document #${document_number}, id:${document_id}`);
    
        if (index && index != "") 
        {
            addCdnToIndex(all_indexes, indexed_document_cdn, index);
            info += `Uploaded document #${document_number} to CDN with fid ${indexed_document_cdn.fid} and id: ${document_id}\n`
        }

        all_chunks = all_chunks.concat(indexed_document_chunks);
        all_cdns.push(indexed_document_cdn);

        document_number +=1;
    }
    if (index && index != "") 
    {
        await saveIndexes(ctx, all_indexes);
        info += `Saved Indexes to DB\n`;
    }

    info += `Indexed ${documents_texts.length} documents in ${all_chunks.length} fragments into Index: ${index} \n`;
    info += `Done`;

    console.timeEnd("indexDocuments_function");

    return { result: { "ok": true }, documents: all_cdns, index, info };
}



export { async_getIndexComponent, indexDocuments_function as ingestText_function };
