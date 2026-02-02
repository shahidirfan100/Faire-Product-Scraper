import { Actor, log, Dataset } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { firefox } from 'playwright';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// CONFIGURATION (defaults, can be overridden by input)
const DETAIL_PAGE_CONCURRENCY = 10;
const PROCESSED_URLS = new Set();

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

let hasLoggedDebug = false;

// Extract product details directly from script content using regex patterns
function extractProductDetailsFromScript(scriptContent) {
    console.log('🔍 Starting regex extraction from script content');
    const details = [];
    
    // Look for attribute patterns in the script content
    // These patterns are based on the actual structure we found in the debug output
    const patterns = [
        // Pattern for translated attributes: "name":{"translated":"SKU"},"value":{"translated":"ABC123"}
        /"name"\\?:\s*\{\s*"translated"\\?:\s*"([^"]+)"\s*\}\s*,\s*"value"\\?:\s*\{\s*"translated"\\?:\s*"([^"]+)"\s*\}/g,
        // Pattern for simple attributes: "name":"SKU","value":"ABC123"  
        /"name"\\?:\s*"([^"]+)"\s*,\s*"value"\\?:\s*"([^"]+)"\s*/g,
        // Pattern for mixed: "name":{"translated":"Made in"},"value":"China"
        /"name"\\?:\s*\{\s*"translated"\\?:\s*"([^"]+)"\s*\}\s*,\s*"value"\\?:\s*"([^"]+)"\s*/g,
        // Pattern for simple name with translated value
        /"name"\\?:\s*"([^"]+)"\s*,\s*"value"\\?:\s*\{\s*"translated"\\?:\s*"([^"]+)"\s*\}/g
    ];
    
    patterns.forEach((pattern, idx) => {
        const matches = [...scriptContent.matchAll(pattern)];
        console.log(`Pattern ${idx} found ${matches.length} matches`);
        matches.forEach(match => {
            const name = match[1];
            const value = match[2];
            if (name && value && value.length > 0 && value.length < 100) {
                // Clean up the values
                const cleanName = name.replace(/\\"/g, '"').trim();
                const cleanValue = value.replace(/\\"/g, '"').trim();
                details.push(`${cleanName}: ${cleanValue}`);
                console.log(`  ✓ Extracted: ${cleanName}: ${cleanValue}`);
            }
        });
    });
    
    console.log(`📊 Regex extraction completed: ${details.length} details found`);
    return details;
}

function normalizeProductRecord(p) {
    if (!p || typeof p !== 'object') return null;

    // DEBUG: Log the first raw product object absolutely reliably
    if (!hasLoggedDebug) {
        console.log('🐛 [DEBUG] FIRST RAW PRODUCT INPUT:', JSON.stringify(p, null, 2));
        hasLoggedDebug = true;
    }

    // Try all possible ID fields
    const token = p.token || p.id || p.productToken || p.product_token || p.slug;
    if (!token) return null;

    // Brand extraction - handle various structures
    const brandObj = p.brand || {};
    let brandName = brandObj.name || p.brandName || p.brand_name || '';
    let brandToken = brandObj.token || p.brandToken || p.brand_token || brandObj.slug || '';

    // Sometimes brand is just a string name
    if (typeof p.brand === 'string') brandName = p.brand;

    const brandUrl = brandToken ? `https://www.faire.com/brand/${brandToken}` : '';

    // Image extraction - aggressive fallbacks
    let imageUrl = null;

    // 1. Array of objects or strings
    if (Array.isArray(p.images) && p.images.length > 0) {
        const firstImg = p.images[0];
        imageUrl = typeof firstImg === 'object' ? (firstImg.url || firstImg.src || firstImg.token) : firstImg;
    }

    // 2. Single object or string
    if (!imageUrl && p.image) {
        imageUrl = typeof p.image === 'object' ? (p.image.url || p.image.src || p.image.token) : p.image;
    }

    // 3. Flat fields
    if (!imageUrl) {
        imageUrl = p.imageUrl || p.image_url || p.thumbnail || p.thumbnailUrl || p.thumbnail_url || p.tile_image?.url || p.square_image?.url || p.medium_image_url || p.original_image_url;
    }

    // 4. Fallback to image token construction if we only have a token
    if (imageUrl && !imageUrl.startsWith('http') && !imageUrl.startsWith('//') && imageUrl.match(/^[a-zA-Z0-9_-]+$/)) {
        imageUrl = `https://cdn.faire.com/fastly/${imageUrl}.jpg`;
    }

    // Normalize image URL
    if (imageUrl && typeof imageUrl === 'string') {
        if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
    }

    // Price extraction
    const priceObj = p.price || {};
    const wholesaleCents = priceObj.wholesale_price_cents || p.wholesale_price_cents || p.wholesalePriceCents || 0;
    const retailCents = priceObj.retail_price_cents || p.retail_price_cents || p.retailPriceCents || 0;

    // Check completeness - FORCE FALSE to ensure we visit detail pages for rich data (Description/SKU/MadeIn)
    const isComplete = false;

    return {
        productUrl: `https://www.faire.com/product/${token}`,
        productName: p.name || p.title || p.productName || p.product_name || '',
        brandName: brandName,
        brandToken: brandToken,
        brandUrl: brandUrl,
        imageUrl: imageUrl,
        wholesalePriceCents: wholesaleCents,
        retailPriceCents: retailCents,
        badges: p.badges || p.tags || [],
        _hasCompleteData: isComplete
    };
}

function extractProductsFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];

    const candidates = [
        // Faire's product_tiles is an array of {product: {...}} objects
        payload.product_tiles?.map(tile => tile.product),
        payload.products,
        payload.results,
        payload?.data?.products,
        payload?.data?.searchProducts?.products,
        payload?.data?.browseProducts?.products,
        payload?.data?.search?.products,
    ].filter(Array.isArray);

    const flattened = candidates.flat();
    return flattened
        .map(normalizeProductRecord)
        .filter(Boolean);
}

function setupNetworkCapture(page) {
    page._capturedProducts = [];
    const seen = new Set();

    page.on('response', async (response) => {
        try {
            const url = response.url();
            const resourceType = response.request().resourceType();

            // Only process XHR/Fetch requests matching our patterns
            if (!['xhr', 'fetch'].includes(resourceType)) return;
            if (!SEARCH_URL_PATTERNS.some((rx) => rx.test(url))) return;

            // Check response status
            const status = response.status();
            if (status !== 200) {
                log.debug(`Non-200 status (${status}) for ${url}`);
                return;
            }

            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json')) return;

            const json = await response.json();
            const products = extractProductsFromPayload(json);

            if (products.length === 0) {
                log.debug(`No products found in response from ${url}`);
                return;
            }

            // Old debug log removed - using reliable one in normalizeProductRecord

            let addedCount = 0;
            for (const product of products) {
                if (!product.productUrl || seen.has(product.productUrl)) continue;
                seen.add(product.productUrl);
                page._capturedProducts.push(product);
                addedCount++;
            }

            if (addedCount > 0) {
                log.info(`📦 Captured ${addedCount} new products from API (${page._capturedProducts.length} total)`);
            }
        } catch (e) {
            // Silent fail for non-critical errors
            log.debug(`Network capture error: ${e.message}`);
        }
    });
}

const STEALTH_SCRIPT = () => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
};

const SEARCH_URL_PATTERNS = [
    /\/api\/v\d+\/layout\/search-product-tiles/i,
    /\/api\/v\d+\/search\/products/i,
    /\/api\/v\d+\/layout\/search-filters/i,
    /search-product-tiles/i,
    /product-tiles/i,
    /graphql/i,
];

async function main() {
    await Actor.init();

    // Load input from INPUT.json directly (more reliable than Actor.getInput() locally)
    let input = {};
    try {
        // Try using require() first (simpler for JSON files)
        input = require('../INPUT.json');
        log.info('✅ Loaded input using require()');
    } catch (e) {
        log.warning('Require failed, trying fs:', e.message);
        try {
            const fs = await import('fs');
            const path = await import('path');
            const inputPath = path.resolve('INPUT.json');
            const inputJson = fs.readFileSync(inputPath, 'utf8');
            log.info('📄 Raw INPUT.json content length:', inputJson.length);
            log.info('📄 First 100 chars:', inputJson.substring(0, 100));
            input = JSON.parse(inputJson);
            log.info('✅ Loaded input using fs.readFileSync');
        } catch (e2) {
            log.error('❌ Failed to load input with fs too:', e2.message);
            input = {
                startUrl: 'https://www.faire.com/search?q=candles',
                resultsWanted: 5,
                proxyConfiguration: { useApifyProxy: false },
                cookies: []
            };
            log.info('⚠️ Using emergency fallback input');
        }
    }

    log.info('📋 Final Input Configuration:', {
        startUrl: input.startUrl,
        resultsWanted: input.resultsWanted,
        proxyEnabled: input.proxyConfiguration?.useApifyProxy,
        cookiesCount: input.cookies?.length || 0
    });

    let {
        startUrl,
        searchQuery,
        resultsWanted = 20,
        proxyConfiguration: proxyConfig,
        cookies = [],
    } = input;

    // Use Search Query if provided and startUrl is missing
    if (!startUrl && searchQuery) {
        log.info(`No Start URL provided. Using Search Query: ${searchQuery}`);
        startUrl = `https://www.faire.com/search?q=${encodeURIComponent(searchQuery)}`;
    }

    if (!startUrl) {
        log.warning('No startUrl or searchQuery in input, using default for testing.');
        startUrl = 'https://www.faire.com/search?q=candles';
    }

    const RESULTS_WANTED = Number.isFinite(+resultsWanted) ? Math.max(1, +resultsWanted) : 20;
    let totalCollected = 0;

    const proxyConfiguration = await Actor.createProxyConfiguration(
        proxyConfig || {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        },
    );

    const crawler = new PlaywrightCrawler({
        launchContext: {
            launcher: firefox,
            launchOptions: {
                headless: true,
            },
            userAgent: getRandomUserAgent(),
        },
        proxyConfiguration,
        maxRequestRetries: 3, // Increased retries for reliability
        maxConcurrency: 1, // Single page at a time for listing pages
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxUsageCount: 15,
                maxErrorScore: 2,
            },
        },
        requestHandlerTimeoutSecs: 180,
        navigationTimeoutSecs: 60,

        preNavigationHooks: [async ({ page, context }) => {
            setupNetworkCapture(page);

            // Enhanced resource blocking for speed and stealth
            await page.route('**/*', (route) => {
                const url = route.request().url();
                const type = route.request().resourceType();

                // Block unnecessary resources
                const blockedTypes = ['image', 'font', 'media', 'stylesheet'];
                const blockedPatterns = [
                    'google-analytics',
                    'googletagmanager',
                    'facebook.com/tr',
                    'doubleclick.net',
                    'hotjar',
                    'amplitude',
                    'segment.com',
                    'mixpanel',
                    '.woff',
                    '.svg',
                    '.jpg',
                    '.jpeg',
                    '.png',
                    '.gif',
                    '.webp',
                ];

                if (blockedTypes.includes(type) || blockedPatterns.some(pattern => url.includes(pattern))) {
                    return route.abort();
                }

                return route.continue();
            });

            // Inject Cookies if provided
            if (cookies && cookies.length > 0) {
                await page.context().addCookies(cookies);
            }

            await page.setViewportSize({ width: 1440, height: 900 });
        }],

        async requestHandler({ page, request, proxyInfo }) {
            if (totalCollected >= RESULTS_WANTED) {
                log.info(`✅ Already collected ${totalCollected} products. Skipping.`);
                return;
            }

            log.info(`Processing listing: ${request.url}`);

            // Wait for page load and initial API calls
            await page.waitForTimeout(3000);

            // Scroll to trigger more API calls
            for (let i = 0; i < 3; i++) {
                await autoScroll(page);
                await page.waitForTimeout(1500);
            }

            // Give network listeners time to collect final responses
            await page.waitForTimeout(1500);

            const capturedFromNetwork = page._capturedProducts || [];
            log.info(`✅ Captured ${capturedFromNetwork.length} products from API interception`);

            let capturedData = capturedFromNetwork;

            // Try DOM fallback if API capture failed
            if (capturedData.length === 0) {
                log.info('🔄 API capture failed, trying DOM fallback...');
                const domProducts = await extractDomProducts(page);
                if (domProducts.length) {
                    log.info(`✅ Recovered ${domProducts.length} products from DOM`);
                    capturedData = domProducts;
                }
            }

            // Try __NEXT_DATA__ as last resort
            if (capturedData.length === 0) {
                log.info('🔄 DOM fallback failed, trying __NEXT_DATA__...');
                const nextDataProducts = await extractNextData(page);
                if (nextDataProducts?.length) {
                    log.info(`✅ Recovered ${nextDataProducts.length} products from __NEXT_DATA__`);
                    capturedData = nextDataProducts.map(normalizeProductRecord).filter(Boolean);
                }
            }

            if (capturedData.length === 0) {
                log.error('❌ No products captured from any source (API/DOM/__NEXT_DATA__). Possible blocking or page structure changed.');
                return;
            }

            // Format and deduplicate
            const toMoney = (value) => {
                if (value === undefined || value === null) return '';
                if (typeof value === 'number') {
                    // Assume cents if value looks like cents, otherwise leave as-is
                    return value > 0 && value < 100000 ? `$${(value / 100).toFixed(2)}` : `$${value.toFixed(2)}`;
                }
                return String(value);
            };

            const allProducts = capturedData.map((p) => ({
                productUrl: p.productUrl,
                productName: p.productName || p.title,
                brandName: p.brandName || '',
                brandUrl: p.brandUrl || (p.brandToken ? `https://www.faire.com/brand/${p.brandToken}` : ''),
                imageUrl: p.imageUrl,
                wholesalePrice: toMoney(p.wholesalePriceCents ?? p.wholesalePrice),
                msrp: toMoney(p.retailPriceCents ?? p.msrp ?? p.retailPrice),
                isBestseller: Array.isArray(p.badges) ? p.badges.includes('bestseller') : !!p.isBestseller,
                isProvenSuccess: Array.isArray(p.badges) ? p.badges.includes('proven') : !!p.isProvenSuccess,
                isNew: Array.isArray(p.badges) ? p.badges.includes('new') : !!p.isNew,
            }));

            const uniqueProducts = [];
            const seen = new Set();
            for (const product of allProducts) {
                if (!seen.has(product.productUrl)) {
                    seen.add(product.productUrl);
                    uniqueProducts.push(product);
                }
            }

            log.info(`Processing ${uniqueProducts.length} unique products (${RESULTS_WANTED} requested)`);
            const toProcess = uniqueProducts.slice(0, RESULTS_WANTED - totalCollected);

            // Check if we have complete data from API (skip detail fetching if yes)
            const productsWithCompleteData = toProcess.filter(p => capturedData.find(c => c.productUrl === p.productUrl)?._hasCompleteData);
            const productsNeedingDetails = toProcess.filter(p => !capturedData.find(c => c.productUrl === p.productUrl)?._hasCompleteData);

            log.info(`✅ ${productsWithCompleteData.length} products have complete data from API`);
            if (productsNeedingDetails.length > 0) {
                log.info(`🔄 ${productsNeedingDetails.length} products need detail page fetch`);
            }

            // Push complete products immediately
            if (productsWithCompleteData.length > 0) {
                const completeResults = productsWithCompleteData.map(p => ({
                    ...p,
                    _scrapedAt: new Date().toISOString()
                }));
                await Dataset.pushData(completeResults);
                totalCollected += completeResults.length;
                log.info(`📊 Pushed ${completeResults.length} complete products to dataset`);
            }

            // Fetch details only for products missing data
            if (productsNeedingDetails.length > 0 && totalCollected < RESULTS_WANTED) {
                const result = await fetchDetailsInBatches(productsNeedingDetails, cookies, proxyInfo?.url, totalCollected, RESULTS_WANTED);
                totalCollected += result.count;
            }

            log.info(`✅ Scraping finished! Total products collected: ${totalCollected}/${RESULTS_WANTED}`);

            // Stop crawler immediately if we have enough results
            if (totalCollected >= RESULTS_WANTED) {
                log.info('🎯 Target reached. Stopping crawler immediately.');
                await crawler.teardown();
            }
        }
    });

    await crawler.run([startUrl]);

    // Final summary
    log.info('='.repeat(60));
    log.info(`🎉 Scraping completed!`);
    log.info(`📊 Total products collected: ${totalCollected}/${RESULTS_WANTED}`);
    log.info(`✅ Success rate: ${((totalCollected / RESULTS_WANTED) * 100).toFixed(1)}%`);
    log.info('='.repeat(60));

    await Actor.exit();
}

// Extract data from __NEXT_DATA__ (Next.js sites)
async function extractNextData(page) {
    try {
        const nextDataText = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : null;
        });

        if (!nextDataText) return null;

        const json = JSON.parse(nextDataText);

        // Navigate through common Next.js structures
        const products = json?.props?.pageProps?.products ||
            json?.props?.pageProps?.data?.products ||
            json?.props?.pageProps?.initialState?.products ||
            json?.props?.pageProps?.results ||
            null;

        if (products && Array.isArray(products)) {
            return products.map(p => ({
                productUrl: p.url || p.productUrl || (p.token ? `https://www.faire.com/product/${p.token}` : null),
                productName: p.name || p.title || p.productName || 'Unknown Product',
                brandName: p.brand?.name || p.brandName || '',
                brandUrl: p.brand?.url || (p.brandToken ? `https://www.faire.com/brand/${p.brandToken}` : ''),
                wholesalePrice: p.wholesalePrice || p.price?.wholesale || '',
                msrp: p.msrp || p.retailPrice || p.price?.retail || '',
                imageUrl: p.imageUrl || p.image || p.thumbnail || null,
                isBestseller: p.isBestseller || p.badges?.includes('bestseller') || false,
                isProvenSuccess: p.isProvenSuccess || p.badges?.includes('proven') || false,
                isNew: p.isNew || p.badges?.includes('new') || false
            })).filter(p => p.productUrl);
        }

        return null;
    } catch (e) {
        return null;
    }
}

async function extractDomProducts(page) {
    const products = await page.$$eval('a[href*="/product/"]', (anchors) => {
        const seen = new Set();
        const items = [];

        anchors.forEach((a) => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/\/product\/([^/?#]+)/);
            if (!match) return;
            const token = match[1];
            if (seen.has(token)) return;
            seen.add(token);

            // Find the closest product card container
            let container = a.closest('[data-testid*="product"]');
            if (!container) container = a.closest('article, [class*="ProductCard"], [class*="product-card"]');
            if (!container) container = a.parentElement;

            // Extract product name - try multiple selectors
            const nameEl = container?.querySelector('[data-testid*="product-name"], h3, h2, [class*="ProductName"]');
            const name = (nameEl?.textContent || a.getAttribute('aria-label') || '').trim();

            // Extract brand name
            const brandEl = container?.querySelector('[data-testid*="brand"], [class*="brand"], [class*="Brand"]');
            const brand = brandEl?.textContent?.trim() || '';

            // Extract image
            const img = container?.querySelector('img');
            const imageUrl = img?.src || img?.getAttribute('data-src') || null;

            // Extract badges
            const badges = [];
            const badgeEls = container?.querySelectorAll('[class*="badge"], [data-testid*="badge"]') || [];
            badgeEls.forEach(badge => {
                const text = badge.textContent?.toLowerCase() || '';
                if (text.includes('bestseller')) badges.push('bestseller');
                if (text.includes('new')) badges.push('new');
                if (text.includes('proven')) badges.push('proven');
            });

            if (name) {
                items.push({
                    productUrl: `https://www.faire.com/product/${token}`,
                    productName: name,
                    brandName: brand,
                    imageUrl: imageUrl,
                    badges: badges,
                });
            }
        });

        return items;
    });

    return products || [];
}

// Batch fetch product details with retry logic - pushes incrementally
async function fetchDetailsInBatches(items, cookies, proxyUrl, currentTotal, targetTotal) {
    let pushedCount = 0;
    const totalBatches = Math.ceil(items.length / DETAIL_PAGE_CONCURRENCY);

    log.info(`🔄 Fetching RICH details for ${items.length} products in ${totalBatches} batches (${DETAIL_PAGE_CONCURRENCY} concurrent)...`);

    for (let i = 0; i < items.length; i += DETAIL_PAGE_CONCURRENCY) {
        if (currentTotal + pushedCount >= targetTotal) break;

        const chunk = items.slice(i, i + DETAIL_PAGE_CONCURRENCY);
        const batchNum = Math.floor(i / DETAIL_PAGE_CONCURRENCY) + 1;

        log.info(`📦 Processing batch ${batchNum}/${totalBatches} (${chunk.length} products)`);
        const promises = chunk.map(item => fetchProductDetails(item, cookies, proxyUrl));
        const chunkResults = await Promise.all(promises);
        const successfulResults = chunkResults.filter(r => r !== null && !r.error);

        if (successfulResults.length > 0) {
            await Dataset.pushData(successfulResults);
            pushedCount += successfulResults.length;
            log.info(`✅ Batch ${batchNum} completed: ${successfulResults.length}/${chunk.length} successful | Pushed ${successfulResults.length} to dataset`);
        } else {
            log.info(`⚠️ Batch ${batchNum} completed: 0/${chunk.length} successful`);
        }

        if (i + DETAIL_PAGE_CONCURRENCY < items.length) {
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }
    }

    log.info(`📊 Total detail fetching: ${pushedCount} products pushed to dataset`);
    return { count: pushedCount };
}

async function fetchProductDetails(listingItem, cookies, proxyUrl) {
    try {
        const cookieHeader = cookies?.map(c => `${c.name}=${c.value}`).join('; ') || '';

        log.debug(`Fetching details for: ${listingItem.productUrl}`);

        const response = await gotScraping({
            url: listingItem.productUrl,
            proxyUrl,
            headers: {
                'Cookie': cookieHeader,
                'Referer': 'https://www.faire.com/',
                'User-Agent': getRandomUserAgent(),
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'firefox', minVersion: 120 }],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows', 'linux', 'macos'],
            },
            timeout: { request: 30000 }
        });

        const html = response.body;
        const $ = cheerio.load(html);

        // === EXTRACT FROM __NEXT_DATA__ (Primary Method) ===
        let nextDataScript = $('#__NEXT_DATA__').html();
        let detailsSection = [];
        
        // If __NEXT_DATA__ is not found, try to find it in self.__next_f.push() format
        if (!nextDataScript) {
            const scripts = $('script').toArray();
            for (const script of scripts) {
                const content = $(script).html();
                if (content && content.includes('self.__next_f.push') && content.includes('product_information_section_groups')) {
                    log.debug('Found flight data with product information');
                    
                    // Extract attributes directly using regex on the escaped content
                    // Pattern matches: \"attribute\":{\"name\":{\"translated\":\"NAME\"},\"value\":{\"translated\":\"VALUE\"}}
                    const attributePattern = /\\"attribute\\":\{\\"name\\":\{\\"translated\\":\\"([^"]+)\\"\},\\"value\\":\{\\"translated\\":\\"([^"]+)\\"\}\}/g;
                    let match;
                    
                    while ((match = attributePattern.exec(content)) !== null) {
                        const name = match[1];
                        const value = match[2];
                        detailsSection.push(`${name}: ${value}`);
                    }
                    
                    if (detailsSection.length > 0) {
                        log.debug(`Extracted ${detailsSection.length} product details via regex`);
                        break;
                    }
                }
            }
        }
        
        if (nextDataScript) {
            try {
                const data = JSON.parse(nextDataScript);
                
                // Look for product data in multiple possible locations
                let product = null;
                const possiblePaths = [
                    'props.pageProps.prefetchedData.product_page.product',
                    'props.pageProps.product',
                    'props.pageProps.prefetchedData.product',
                    'props.pageProps.data.product',
                    'props.pageProps.initialState.product',
                    'product',
                    'props.state.queries[0].state.data.product' // From the script data
                ];

                for (const path of possiblePaths) {
                    product = path.split('.').reduce((obj, key) => {
                        if (key.includes('[')) {
                            // Handle array access like queries[0]
                            const arrayMatch = key.match(/^(.+)\[(\d+)\]$/);
                            if (arrayMatch) {
                                const arrayKey = arrayMatch[1];
                                const index = parseInt(arrayMatch[2]);
                                return obj?.[arrayKey]?.[index];
                            }
                        }
                        return obj?.[key];
                    }, data);
                    
                    if (product && typeof product === 'object' && product.token) {
                        break;
                    }
                }
                
                if (product) {
                    // Extract structured details from the product object
                    const detailsSections = product.details?.product_information_section_groups || 
                                          product.details?.attribute_tags || [];
                    
                    // Handle different data structures
                    if (Array.isArray(detailsSections)) {
                        detailsSections.forEach(group => {
                            if (group.sections) {
                                // Original structure
                                group.sections?.forEach(section => {
                                    section.entries?.forEach(entry => {
                                        if (entry.attribute) {
                                            const key = entry.attribute.name?.translated || entry.attribute.name || '';
                                            const value = entry.attribute.value?.translated || entry.attribute.value || '';
                                            if (key && value) {
                                                detailsSection.push(`${key}: ${value}`);
                                            }
                                        }
                                    });
                                });
                            } else if (group.attribute) {
                                // Alternative structure
                                const key = group.attribute.name?.translated || group.attribute.name || '';
                                const value = group.attribute.value?.translated || group.attribute.value || '';
                                if (key && value) {
                                    detailsSection.push(`${key}: ${value}`);
                                }
                            }
                        });
                    }
                    
                    // Check for option-level entries (new structure)
                    if (product.details?.product_information_section_groups) {
                        product.details.product_information_section_groups.forEach(group => {
                            if (group.option_level_entries_by_option_token) {
                                Object.values(group.option_level_entries_by_option_token).forEach(optionEntries => {
                                    if (optionEntries.entries) {
                                        optionEntries.entries.forEach(entry => {
                                            if (entry.attribute) {
                                                const key = entry.attribute.name?.translated || entry.attribute.name || '';
                                                const value = entry.attribute.value?.translated || entry.attribute.value || '';
                                                if (key && value) {
                                                    detailsSection.push(`${key}: ${value}`);
                                                }
                                            }
                                        });
                                    }
                                });
                            }
                        });
                    }
                    
                    // Also check for direct properties
                    if (product.importShipmentInfo) {
                        detailsSection.push(`Ships from: ${product.importShipmentInfo}`);
                    }
                    
                    log.debug(`Extracted ${detailsSection.length} details from product data`);
                } else {
                    log.debug('Product not found in parsed data');
                }
            } catch (e) {
                log.warning(`Failed to parse __NEXT_DATA__: ${e.message}`);
            }
        } else {
            log.debug('No __NEXT_DATA__ found in any format');
        }

        // === FALLBACK: Extract from HTML text if JSON parsing failed ===
        if (detailsSection.length === 0) {
            log.debug('Attempting fallback extraction from HTML text');
            
            const bodyText = $('body').text();
            
            // Look for the specific JSON-like patterns we found in the debug output
            const jsonPatterns = [
                /"SKU":\s*"([^"]+)"/,
                /"Made in":\s*"([^"]+)"/,
                /"Dimensions":\s*"([^"]+)"/,
                /"Materials":\s*"([^"]+)"/,
                /"Color":\s*"([^"]+)"/,
                /"Ships from":\s*"([^"]+)"/,
                /"Minimum Order":\s*"([^"]+)"/,
                /"Case Pack":\s*"([^"]+)"/
            ];
            
            jsonPatterns.forEach(pattern => {
                const match = bodyText.match(pattern);
                if (match && match[1]) {
                    const value = match[1].trim();
                    // Extract key name from pattern
                    const keyMatch = pattern.source.match(/"([^"]+)":/);
                    if (keyMatch && keyMatch[1] && value.length > 0 && value.length < 100) { // Sanity check
                        const key = keyMatch[1];
                        detailsSection.push(`${key}: ${value}`);
                        log.debug(`Found via JSON pattern: ${key}: ${value}`);
                    }
                }
            });
            
            // If JSON patterns didn't work, try text patterns with better boundaries
            if (detailsSection.length === 0) {
                const textPatterns = [
                    /\bSKU:\s*([^\n\r,}]{1,50}?)(?=\s*["}])/i,
                    /\bMade in:\s*([^\n\r,}]{1,50}?)(?=\s*["}])/i,
                    /\bDimensions:\s*([^\n\r,}]{1,100}?)(?=\s*["}])/i,
                    /\bMaterials:\s*([^\n\r,}]{1,50}?)(?=\s*["}])/i,
                    /\bColor:\s*([^\n\r,}]{1,50}?)(?=\s*["}])/i,
                    /\bShips from:\s*([^\n\r,}]{1,50}?)(?=\s*["}])/i
                ];
                
                textPatterns.forEach(pattern => {
                    const match = bodyText.match(pattern);
                    if (match && match[1]) {
                        const value = match[1].trim();
                        if (value.length > 0 && value.length < 100 && !value.includes('{') && !value.includes('}')) {
                            // Extract key from pattern
                            const keyMatch = pattern.source.match(/\b(\w+(?:\s+\w+)*):/);
                            if (keyMatch && keyMatch[1]) {
                                const key = keyMatch[1];
                                detailsSection.push(`${key}: ${value}`);
                                log.debug(`Found via text pattern: ${key}: ${value}`);
                            }
                        }
                    }
                });
            }
        }

        // Helper function to extract detail value by key with multiple variations
        const getDetailValue = (keys) => {
            if (!Array.isArray(keys)) keys = [keys];
            
            for (const key of keys) {
                const detail = detailsSection.find(d => {
                    const lower = d.toLowerCase();
                    const keyLower = key.toLowerCase();
                    return lower.startsWith(keyLower + ':') || lower.includes(keyLower + ':');
                });
                
                if (detail) {
                    return detail.split(':').slice(1).join(':').trim();
                }
            }
            
            return '';
        };

        // === EXTRACT STRUCTURED PRODUCT DETAILS ===
        
        // 1. Description (try multiple selectors)
        const description = $('[data-testid="product-description"]').text().trim()
            || $('div[class*="Description"] p').first().text().trim()
            || $('div[class*="description"] p').first().text().trim()
            || $('div#product-description-content').text().trim()
            || $('section[class*="Description"]').text().trim()
            || $('meta[property="og:description"]').attr('content')?.trim()
            || $('meta[name="description"]').attr('content')?.trim()
            || '';

        // 2. SKU - Try to find in detail items
        const sku = getDetailValue(['SKU', 'Product Code', 'Item Number', 'Style Number']);

        // 3. Made In / Country of Origin
        const madeIn = getDetailValue(['Made in', 'Country of Origin', 'Origin', 'Manufactured in']);

        // 4. Shipping / Delivery Info
        const delivery = getDetailValue(['Ships in', 'Shipping Time', 'Delivery Time', 'Ships from', 'Delivery', 'Lead Time']);

        // 5. Dimensions (Weight, Size, Dimensions)
        const dimensions = getDetailValue(['Dimensions', 'Weight', 'Size', 'Product Dimensions', 'Package Dimensions']);

        // 6. Materials
        const materials = getDetailValue(['Material', 'Materials', 'Product Materials', 'Composition', 'Fabric', 'Made of']);

        // 7. Minimum Order
        const minimumOrder = getDetailValue(['Minimum Order', 'Min Order', 'MOQ', 'Minimum Quantity', 'Order Minimum']);

        // 8. Case Pack Quantity
        const casePackQuantity = getDetailValue(['Case Pack', 'Pack Quantity', 'Units per Case', 'Case Quantity', 'Inner Pack']);

        // 9. Additional product-specific fields
        const color = getDetailValue(['Color', 'Colour', 'Primary Color', 'Main Color']);

        // === PRESERVE LISTING DATA WITH FALLBACKS ===

        // Brand Name - prefer listing data, fallback to detail page
        const brandName = listingItem.brandName 
            || $('[data-testid="brand-name"]').text().trim() 
            || $('a[href*="/brand/"]').first().text().trim() 
            || '';

        // Product Name - prefer listing data, fallback to detail page
        const productName = listingItem.productName 
            || $('h1').first().text().trim() 
            || $('[data-testid="product-title"]').text().trim() 
            || $('meta[property="og:title"]').attr('content')?.trim()
            || '';

        // Image URL - prefer listing data, fallback to detail page
        const imageUrl = listingItem.imageUrl
            || $('meta[property="og:image"]').attr('content')
            || $('img[data-testid="product-image"]').attr('src')
            || $('img[class*="ProductImage"]').first().attr('src')
            || $('img[alt*="product"]').first().attr('src')
            || '';

        // Prices - PRESERVE listing prices, don't overwrite unless missing
        const wholesalePrice = listingItem.wholesalePrice || '';
        const msrp = listingItem.msrp || '';

        // Construct complete product object with ALL fields
        const completeProduct = {
            // Core identifiers
            productUrl: listingItem.productUrl,
            productName,
            brandName,
            brandUrl: listingItem.brandUrl || '',
            imageUrl,
            
            // Prices (from listing)
            wholesalePrice,
            msrp,
            
            // Badges (from listing)
            isBestseller: listingItem.isBestseller || false,
            isProvenSuccess: listingItem.isProvenSuccess || false,
            isNew: listingItem.isNew || false,
            
            // Detail page fields (structured data)
            description,
            sku,
            madeIn,
            delivery,
            minimumOrder,
            casePackQuantity,
            dimensions,
            materials,
            
            // Additional product-specific fields
            color,
            
            // Metadata
            _scrapedAt: new Date().toISOString(),
            _detailsFetched: true
        };

        log.debug(`✅ Details extracted for ${productName} - SKU: ${sku || 'N/A'}, Made in: ${madeIn || 'N/A'}`);

        return completeProduct;

    } catch (e) {
        log.warning(`❌ Failed to fetch details for ${listingItem.productUrl}: ${e.message}`);
        return {
            ...listingItem,
            description: '',
            sku: '',
            madeIn: '',
            delivery: '',
            minimumOrder: '',
            casePackQuantity: '',
            dimensions: '',
            materials: '',
            color: '',
            error: `Detail fetch failed: ${e.message}`,
            _scrapedAt: new Date().toISOString(),
            _detailsFetched: false
        };
    }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 20000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150);
        });
    });
}

main().catch((error) => {
    log.error('Actor failed', { error: error.message });
    process.exit(1);
});
