<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405); echo json_encode(['error' => 'Method not allowed']); exit;
}

require_once __DIR__ . '/../config.php';

if (!defined('OPENAI_API_KEY') || OPENAI_API_KEY === '' || OPENAI_API_KEY === 'sk-YOUR-KEY-HERE') {
    http_response_code(400);
    echo json_encode(['error' => 'OpenAI API key non configurata nel server o in config.local.php']); exit;
}

$rawInput = file_get_contents('php://input');
if ($rawInput === false || strlen($rawInput) > 16384) {
    http_response_code(413); echo json_encode(['error' => 'Payload troppo grande']); exit;
}

$input = json_decode($rawInput, true);
if (!is_array($input) || !isset($input['coin']) || !is_array($input['coin'])) {
    http_response_code(400); echo json_encode(['error' => 'Input non valido']); exit;
}

function clean_text($value, int $maxLength = 80): string {
    if (!is_scalar($value)) return '—';
    $clean = trim(strip_tags((string) $value));
    return substr($clean, 0, $maxLength);
}

function clean_number($value, float $min, float $max): string {
    $normalized = str_replace(',', '', clean_text($value, 32));
    if (!is_numeric($normalized)) return '—';
    $number = max($min, min($max, (float) $normalized));
    return rtrim(rtrim(number_format($number, 8, '.', ''), '0'), '.');
}

$coinInput = $input['coin'];
$marketInput = isset($input['market']) && is_array($input['market']) ? $input['market'] : [];
$c = [
    'name' => clean_text($coinInput['name'] ?? '', 60),
    'symbol' => clean_text($coinInput['symbol'] ?? '', 16),
    'price' => clean_number($coinInput['price'] ?? null, 0.00000001, 1000000000),
    'rank' => clean_number($coinInput['rank'] ?? null, 1, 100000),
    'ch1h' => clean_number($coinInput['ch1h'] ?? null, -100, 10000),
    'ch24h' => clean_number($coinInput['ch24h'] ?? null, -100, 10000),
    'ch7d' => clean_number($coinInput['ch7d'] ?? null, -100, 10000),
    'rsi1d' => clean_number($coinInput['rsi1d'] ?? null, 0, 100),
    'rsi7d' => clean_number($coinInput['rsi7d'] ?? null, 0, 100),
    'volatility' => clean_number($coinInput['volatility'] ?? null, 0, 10000),
    'volRatio' => clean_number($coinInput['volRatio'] ?? null, 0, 10000),
    'signal' => clean_text($coinInput['signal'] ?? 'nessuno', 40),
];
$mkt = [
    'fng' => clean_number($marketInput['fng'] ?? null, 0, 100),
    'btcDom' => clean_number($marketInput['btcDom'] ?? null, 0, 100),
    'mcapChange' => clean_number($marketInput['mcapChange'] ?? null, -100, 10000),
];

// ── Sistema prompt: conciso, orientato al task ──────────────────────────────
$system = <<<SYSTEM
Sei un analista quantitativo crypto senior. Fornisci analisi tecniche operative
e proposte di trading precise basate sui dati forniti. Ragiona su RSI, momentum,
volatilità e contesto di mercato per determinare entry ottimale, stop loss e
target multipli con rapporto rischio/rendimento favorevole.
Rispondi in italiano, con tono diretto e professionale.
SYSTEM;

// ── User prompt: dati strutturati, richiesta chiara ─────────────────────────
$userPrompt = <<<USER
Analizza i seguenti dati tecnici e fornisci una proposta di trading operativa.

== ASSET ==
Nome:           {$c['name']} ({$c['symbol']})
Prezzo:         \${$c['price']}
Rank MCap:      #{$c['rank']}
Variazione 1h:  {$c['ch1h']}%
Variazione 24h: {$c['ch24h']}%
Variazione 7d:  {$c['ch7d']}%
RSI 1D:         {$c['rsi1d']}
RSI 7D:         {$c['rsi7d']}
Volatilità:     {$c['volatility']}%
Vol/MCap ratio: {$c['volRatio']}%
Segnale algo:   {$c['signal']}

== CONTESTO MERCATO ==
Fear & Greed:   {$mkt['fng']}/100
BTC Dominance:  {$mkt['btcDom']}%
MCap Δ 24h:     {$mkt['mcapChange']}%

Fornisci analisi tecnica e livelli di trading con entry precisa, stop loss
e almeno due target di profitto. Calcola i prezzi in modo coerente con
la volatilità dell'asset. Il timeframe deve essere appropriato al segnale.
USER;

// ── JSON Schema — Structured Outputs (supportato da gpt-4o e versioni successive) ──
$schema = [
    'type' => 'object',
    'properties' => [
        'analisi' => [
            'type' => 'string',
            'description' => '2-4 frasi di analisi tecnica: stato RSI, momentum, contesto mercato e bias direzionale'
        ],
        'direzione' => [
            'type' => 'string',
            'enum' => ['LONG', 'SHORT', 'NEUTRALE'],
            'description' => 'Direzione del trade suggerito'
        ],
        'entry' => [
            'type' => 'number',
            'description' => 'Prezzo di ingresso suggerito (zona ottimale)'
        ],
        'stop_loss' => [
            'type' => 'number',
            'description' => 'Prezzo di stop loss — oltre questo livello la tesi di trade è invalidata'
        ],
        'take_profit_1' => [
            'type' => 'number',
            'description' => 'Primo target di profitto (R:R minimo 1.5:1)'
        ],
        'take_profit_2' => [
            'type' => 'number',
            'description' => 'Secondo target di profitto (R:R 2.5:1 o più)'
        ],
        'take_profit_3' => [
            'type' => ['number', 'null'],
            'description' => 'Terzo target opzionale per alta volatilità (può essere null)'
        ],
        'rischio' => [
            'type' => 'string',
            'enum' => ['BASSO', 'MEDIO', 'ALTO'],
            'description' => 'Livello di rischio del trade in base a volatilità e contesto'
        ],
        'confidenza' => [
            'type' => 'integer',
            'minimum' => 0,
            'maximum' => 100,
            'description' => 'Confidenza nella proposta: 0-100 basata sulla forza dei segnali convergenti'
        ],
        'timeframe' => [
            'type' => 'string',
            'enum' => ['scalping', 'breve termine', 'medio termine', 'lungo termine'],
            'description' => 'Orizzonte temporale suggerito per il trade'
        ],
        'note' => [
            'type' => 'string',
            'description' => 'Note operative aggiuntive (livelli chiave, catalizzatori, rischi specifici) oppure stringa vuota'
        ]
    ],
    'required'             => ['analisi','direzione','entry','stop_loss','take_profit_1','take_profit_2','take_profit_3','rischio','confidenza','timeframe','note'],
    'additionalProperties' => false,
];

$payload = [
    'model'    => OPENAI_MODEL,
    'messages' => [
        ['role' => 'system', 'content' => $system],
        ['role' => 'user',   'content' => $userPrompt],
    ],
    'response_format' => [
        'type'        => 'json_schema',
        'json_schema' => [
            'name'   => 'trading_analysis',
            'strict' => true,
            'schema' => $schema,
        ],
    ],
    'temperature'            => 0.20,
    'max_completion_tokens'  => 1200,
];

if (!function_exists('curl_init')) {
    http_response_code(500); echo json_encode(['error' => 'cURL non disponibile sul server']); exit;
}

$ch = curl_init('https://api.openai.com/v1/chat/completions');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . OPENAI_API_KEY,
    ],
    CURLOPT_TIMEOUT        => 45,
    CURLOPT_SSL_VERIFYPEER => true,
]);

$resp     = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($curlErr) {
    http_response_code(500); echo json_encode(['error' => 'cURL error: ' . $curlErr]); exit;
}

$apiData = json_decode($resp, true);

if ($httpCode !== 200) {
    $msg = $apiData['error']['message'] ?? "HTTP $httpCode";
    http_response_code(500); echo json_encode(['error' => 'OpenAI error: ' . $msg]); exit;
}

// Gestione refusal (modelli nuovi possono rifiutare contenuti)
$refusal = $apiData['choices'][0]['message']['refusal'] ?? null;
if ($refusal) {
    http_response_code(400);
    echo json_encode(['error' => 'AI ha rifiutato la richiesta: ' . $refusal]); exit;
}

$content = $apiData['choices'][0]['message']['content'] ?? null;
if (!$content) {
    http_response_code(500); echo json_encode(['error' => 'Risposta AI vuota']); exit;
}

// Verifica che sia JSON valido prima di rispedire
$parsed = json_decode($content, true);
if (json_last_error() !== JSON_ERROR_NONE) {
    // Fallback: prova json_object se json_schema non supportato dal modello
    http_response_code(500);
    echo json_encode(['error' => 'JSON non valido dalla risposta AI']); exit;
}

// Sanity check sui prezzi (evita allucinazioni numeriche grossolane)
$price = (float) str_replace(',', '', $c['price']);
if ($price > 0) {
    $maxDeviation = 0.5; // massimo 50% di scostamento dal prezzo corrente
    foreach (['entry', 'stop_loss', 'take_profit_1', 'take_profit_2'] as $field) {
        if (isset($parsed[$field]) && $parsed[$field] > 0) {
            $dev = abs($parsed[$field] - $price) / $price;
            if ($dev > $maxDeviation) {
                // Prezzo fuori range: scala proporzionalmente
                $ratio = $parsed[$field] / $price;
                $parsed[$field] = round($price * max(0.5, min(1.5, $ratio)), 8);
            }
        }
    }
}

echo json_encode($parsed, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
