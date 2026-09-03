<?php
/**
 * Polyfills for PHP extensions that shared hosting often ships disabled.
 *
 * cPanel's "Select PHP Version" screen lets an account turn mbstring and
 * fileinfo off, and several hosts ship them off by default. Calling a missing
 * function is a fatal error, which would kill the installer before it could
 * explain what to enable — so the handful of functions MyLoom needs are
 * defined here when absent.
 *
 * Loaded as the very first thing in bootstrap.php, before any other code runs.
 */

if (!function_exists('mb_internal_encoding')) {
    function mb_internal_encoding($encoding = null)
    {
        return $encoding === null ? 'UTF-8' : true;
    }
}

if (!function_exists('mb_strlen')) {
    function mb_strlen($string, $encoding = null)
    {
        $string = (string)$string;
        if (function_exists('iconv_strlen')) {
            $length = @iconv_strlen($string, 'UTF-8');
            if ($length !== false) {
                return $length;
            }
        }
        $count = preg_match_all('/./us', $string);
        return $count === false ? strlen($string) : $count;
    }
}

if (!function_exists('mb_substr')) {
    function mb_substr($string, $start, $length = null, $encoding = null)
    {
        $string = (string)$string;
        $start = (int)$start;

        // iconv handles long strings without building a character array.
        if (function_exists('iconv_substr') && function_exists('iconv_strlen')) {
            $total = @iconv_strlen($string, 'UTF-8');
            if ($total !== false) {
                if ($start < 0) {
                    $start = max(0, $total + $start);
                }
                if ($start >= $total) {
                    return '';
                }
                $take = $length === null ? $total - $start : (int)$length;
                if ($take < 0) {
                    $take = max(0, $total - $start + $take);
                }
                $out = @iconv_substr($string, $start, $take, 'UTF-8');
                if ($out !== false) {
                    return $out;
                }
            }
        }

        $chars = preg_split('//u', $string, -1, PREG_SPLIT_NO_EMPTY);
        if ($chars === false) {
            // Invalid UTF-8: fall back to bytes rather than returning nothing.
            return $length === null ? substr($string, $start) : substr($string, $start, (int)$length);
        }
        $slice = $length === null
            ? array_slice($chars, $start)
            : array_slice($chars, $start, (int)$length);
        return implode('', $slice);
    }
}

if (!function_exists('mb_strtolower')) {
    function mb_strtolower($string, $encoding = null)
    {
        // strtolower only maps A-Z, and every byte of a multi-byte UTF-8
        // sequence is >= 0x80, so this is byte-safe. It simply will not fold
        // accented capitals — acceptable for the search and email comparisons
        // this is used for.
        return strtolower((string)$string);
    }
}

if (!function_exists('mb_strtoupper')) {
    function mb_strtoupper($string, $encoding = null)
    {
        return strtoupper((string)$string);
    }
}
