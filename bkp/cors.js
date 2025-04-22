// Constants for static content 
const STATIC_CONTENT = {
    MIME_TYPES: {
        '.png': 'image/png',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.ico': 'image/x-icon',
        '.html': 'text/html; charset=utf-8',
        '.webmanifest': 'application/manifest+json',
        '.xml': 'application/xml',
        '.gz': 'application/gzip',
        '.br': 'application/brotli',
        '.svg': 'image/svg+xml',
        '.json': 'application/json; charset=utf-8'
    },

    CORS: {
        ALLOWED_ORIGINS: [
            'http://localhost:5173',
            `http://localhost:${config.port}`
        ],
        ALLOWED_METHODS: [
            'GET',
            'POST',
            'PUT',
            'DELETE',
            'OPTIONS'
        ]
    }
};

/**
 * Generates CORS headers with content type
 *
 * @param {string} contentType - MIME type for Content-Type header
 * @param {Object} [options] - Additional options
 * @param {string[]} [options.allowedOrigins] - Allowed origins
 * @param {string[]} [options.allowedMethods] - Allowed HTTP methods
 * @param {number} [options.maxAge] - Cache max age in seconds
 * @returns {Object} CORS headers object
 */
function generateCorsHeaders(
    contentType,
    {
        allowedOrigins = STATIC_CONTENT.CORS.ALLOWED_ORIGINS,
        allowedMethods = STATIC_CONTENT.CORS.ALLOWED_METHODS,
        maxAge = config.defaultCORSMaxAge
    } = {}
) {
    return {
        'Access-Control-Allow-Origin': allowedOrigins.join(', '),
        'Access-Control-Allow-Methods': allowedMethods.join(', '),
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': maxAge,
        'Content-Type': contentType
    };
}

/**
 * Recursively scans directory and collects file information
 *
 * @param {string} directoryPath - Directory to scan
 * @returns {Array<{path: string, extension: string}>} Array of file info objects
 */
function scanDirectory(directoryPath) {
    try {
        const files = fs.readdirSync(directoryPath);
        const results = [];

        for (const file of files) {
            const filePath = path_fs.join(directoryPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                results.push(...scanDirectory(filePath));
            } else {
                results.push({
                    path: filePath,
                    extension: path_fs.extname(filePath)
                });
            }
        }

        return results;

    } catch (error) {
        logger.error('Failed to scan directory', {
            directory: directoryPath,
            error: error.message
        });
        return [];
    }
}

/**
 * Builds static asset map from directory contents
 * 
 * @param {Array<{path: string, extension: string}>} files - Array of file info objects
 * @returns {Map<string, {content: Buffer, type: string}>} Static asset map
 */
function buildStaticAssets(files) {
    const assets = new Map();

    try {
        // Process each file
        for (const file of files) {
            const urlPath = file.path.replace('dist', config.urlBase);
            const content = fs.readFileSync(file.path);
            const type = STATIC_CONTENT.MIME_TYPES[file.extension];

            assets.set(urlPath, { content, type });
        }

        // Add index.html variants
        const indexPath = `${config.urlBase}/index.html`;
        if (assets.has(indexPath)) {
            const indexContent = assets.get(indexPath);

            // Add standard variants
            assets.set(`${config.urlBase}/`, indexContent);
            assets.set(config.urlBase, indexContent);

            // Add compressed variants
            assets.set(`${config.urlBase}/.gz`, indexContent);
            assets.set(`${config.urlBase}.gz`, indexContent);
            assets.set(`${config.urlBase}/.br`, indexContent);
            assets.set(`${config.urlBase}.br`, indexContent);
        }

        return assets;

    } catch (error) {
        logger.error('Failed to build static assets', {
            error: error.message
        });
        return new Map();
    }
}

// Initialize static content
const scannedFiles = scanDirectory('dist');
const staticAssets = buildStaticAssets(scannedFiles);