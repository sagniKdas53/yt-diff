// Add this near the top with other semaphores/tracking
const ListingSemaphore = {
    maxConcurrent: config.queue.maxListings,
    currentConcurrent: 1,
    queue: [],

    async acquire() {
        return new Promise(resolve => {
            if (this.currentConcurrent < this.maxConcurrent) {
                this.currentConcurrent++;
                logger.debug(`Listing semaphore acquired, current concurrent: ${this.currentConcurrent}`);
                resolve();
            } else {
                logger.debug(`Listing semaphore full, queuing request`);
                this.queue.push(resolve);
            }
        });
    },

    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            logger.debug(`Listing semaphore released, current concurrent: ${this.currentConcurrent}`);
            next();
        } else {
            logger.debug(`Listing semaphore released`);
            this.currentConcurrent--;
        }
    },

    setMaxConcurrent(max) {
        this.maxConcurrent = max;
        while (this.currentConcurrent < this.maxConcurrent && this.queue.length > 0) {
            const next = this.queue.shift();
            this.currentConcurrent++;
            next();
        }
    }
};

// Now modify the processUrlList function to use parallel processing:
````javascript
// filepath: [index.js](http://_vscodecontentref_/2)
async function processUrlList(requestBody, response) {
    try {
        // Validate required parameters
        if (!requestBody.url_list) {
            throw new Error("URL list is required");
        }

        // Extract and normalize parameters
        const startIndex = Math.max(1, +(requestBody.start ?? 1));
        const chunkSize = Math.max(config.chunkSize, +(requestBody.chunk_size ?? config.chunkSize));
        const endIndex = startIndex + chunkSize;
        const shouldSleep = requestBody.sleep ?? false;
        const monitoringType = requestBody.monitoring_type ?? "N/A";
        const lastProcessedIndex = startIndex > 0 ? startIndex - 1 : 0;

        logger.trace("Processing URL list", {
            urlCount: requestBody.url_list.length,
            startIndex,
            endIndex,
            chunkSize,
            shouldSleep,
            monitoringType
        });

        // Process URLs in parallel with semaphore control
        const processingResults = await Promise.allSettled(
            requestBody.url_list.map((currentUrl, urlIndex) =>
                processUrlWithSemaphore(
                    currentUrl,
                    requestBody,
                    urlIndex,
                    response,
                    shouldSleep,
                    lastProcessedIndex,
                    startIndex,
                    endIndex,
                    chunkSize,
                    monitoringType
                )
            )
        );

        // Log results
        processingResults.forEach((result, index) => {
            const url = requestBody.url_list[index];
            if (result.status === 'fulfilled') {
                logger.debug(`Successfully processed URL: ${url}`);
            } else {
                logger.error("Error processing URL", {
                    url: url,
                    error: result.reason.message
                });
            }
        });

        logger.debug("Completed processing all URLs");

    } catch (error) {
        logger.error("Failed to process URL list", {
            error: error.message,
            stack: error.stack
        });
    }
}

async function processUrlWithSemaphore(
    currentUrl,
    requestBody,
    urlIndex,
    response,
    shouldSleep,
    lastProcessedIndex,
    startIndex,
    endIndex,
    chunkSize,
    monitoringType
) {
    await ListingSemaphore.acquire();

    try {
        const result = await initializeListProcessing(
            currentUrl,
            requestBody,
            urlIndex,
            response,
            shouldSleep,
            lastProcessedIndex,
            startIndex,
            endIndex,
            chunkSize,
            monitoringType
        );

        return result;
    } catch (error) {
        // Send error response only for first URL
        if (urlIndex === 0) {
            const status = error.status || 500;
            response.writeHead(status, generateCorsHeaders(MIME_TYPES[".json"]));
            response.end(JSON.stringify({ error: he.escape(error.message) }));
        }

        // Notify frontend of failure
        sock.emit("listing-failed", {
            error: error.message,
            url: currentUrl === "None" ? requestBody.url_list[urlIndex] : currentUrl
        });

        throw error;
    } finally {
        ListingSemaphore.release();
    }
}