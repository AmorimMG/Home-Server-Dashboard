"use client";
import { USER_ID } from "@/utils/constants";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import { Heart, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import Image from "next/image";
import { ComponentProps, useEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { Snowflake, useLanyardWS } from "use-lanyard";
import { Modal } from "./Modal";

const LYRICS_TIMING_OFFSET = -300; // Ajuste este valor conforme necessário (-300 = 300ms mais cedo)

let startedTimestamp = 0;
let endTimestamp = 0;

const defaultSong = {
  track: {
    album: {
      images: [
        {
          height: 640,
          url: "https://i.scdn.co/image/ab67616d0000b27398f622b722bb7dea65ca0acf",
          width: 640,
        },
      ],
      name: "hypochondriac",
    },
    artists: [
      {
        name: "brakence",
      },
    ],
    duration_ms: 195882,
    external_urls: {
      spotify: "https://open.spotify.com/track/159CffclwSTvynlA0BUlQG",
    },
    name: "venus fly trap",
  },
  played_at: "2023-02-06T14:16:32.895Z",
};

function getMinuteAndSeconds(date: Date) {
  return date.toLocaleTimeString(navigator.language, {
    minute: "2-digit",
    second: "2-digit",
  });
}

interface LRCLibResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string;
  syncedLyrics: string;
}

interface TimedLyric {
  time: number;
  text: string;
}

const parseSyncedLyrics = (syncedLyrics: string): TimedLyric[] => {
  const lines = syncedLyrics.split('\n');
  // Ajustando o regex para capturar o formato correto da LRCLib
  const timeRegex = /\[(\d{2}):(\d{2}\.\d{2})\]/;
  
  return lines
    .map(line => {
      const match = timeRegex.exec(line);
      if (!match) return null;
      
      const minutes = parseInt(match[1]);
      const [seconds, centiseconds] = match[2].split('.').map(Number);
      // Convertendo para milissegundos
      const time = (minutes * 60 * 1000) + (seconds * 1000) + (centiseconds * 10);
      // Removendo o timestamp e espaços extras
      const text = line.replace(timeRegex, '').trim();
      
      return text ? { time, text } : null;
    })
    .filter((lyric): lyric is TimedLyric => lyric !== null);
};

const convertToTimedLyrics = (lyricsText: string): TimedLyric[] => {
  return lyricsText
    .split('\n')
    .filter(line => line.trim())
    .map((line, index) => ({
      time: index * 3000, // Each line shows for 3 seconds
      text: line.trim()
    }));
};

export function Lanyard({ ...props }: ComponentProps<"div">) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [elapsed, setElapsed] = useState<Date | undefined>();
  const [lastPlayed, setLastPlayed] = useState<any>();
  const [lyrics, setLyrics] = useState<TimedLyric[]>([]);
  const [currentLyricIndex, setCurrentLyricIndex] = useState<number>(0);
  const [progress, setProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = useLanyardWS(USER_ID as Snowflake);

  const currentLyric = lyrics[currentLyricIndex];

  const timestampsRef = useRef({
    start: 0,
    end: 0,
    initialized: false
  });

  const duration = user?.spotify?.timestamps
    ? new Date(user.spotify.timestamps.end - user.spotify.timestamps.start)
    : undefined;

  const SPOTIFY_API_URL = "https://api.amorim.pro/spotify";

  // Function to send commands to Spotify API
  const sendCommand = async (command: string) => {
    try {
      const endpoint = `${SPOTIFY_API_URL}/${command}`;
      await axios({
        method: "POST",
        url: endpoint,
      });
    } catch (error) {
      console.error(`Error sending ${command} command:`, error);
    }
  };

  // Playback control functions
  const pauseMusic = () => sendCommand("pause");
  const playMusic = () => sendCommand("play");
  const skipNext = () => sendCommand("next");
  const skipBack = () => sendCommand("previous");

  const fetchLyrics = async (artist: string, song: string, album: string, duration: number) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams({
        artist_name: artist,
        track_name: song,
        album_name: album,
        duration: Math.floor(duration / 1000).toString() // Converter ms para segundos
      });

      const response = await axios.get<LRCLibResponse>(
        `https://lrclib.net/api/get?${params.toString()}`
      );

      if (response.data.syncedLyrics) {
        const timedLyrics = parseSyncedLyrics(response.data.syncedLyrics);
        setLyrics(timedLyrics);
      } else if (response.data.plainLyrics) {
        // Fallback para letras não sincronizadas
        const timedLyrics = convertToTimedLyrics(response.data.plainLyrics);
        setLyrics(timedLyrics);
      } else {
        setLyrics([]);
        setError('No lyrics found');
      }
    } catch (error) {
      console.error('Error fetching lyrics:', error);
      setLyrics([]);
      setError('Failed to load lyrics');
    } finally {
      setIsLoading(false);
    }
  };

  const updateCurrentLyric = (currentTime: number) => {
    if (!lyrics.length) return;

    const index = lyrics.findIndex((lyric, i) => {
      const nextLyric = lyrics[i + 1];
      const currentMs = currentTime;
      
      if (!nextLyric) {
        return currentMs >= lyric.time;
      }
      
      return currentMs >= lyric.time && currentMs < nextLyric.time;
    });

    if (index !== -1 && index !== currentLyricIndex) {
      setCurrentLyricIndex(index);
      
      // Auto-scroll para a letra atual
      const lyricElement = document.querySelector(`[data-lyric-index="${index}"]`);
      lyricElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  useEffect(() => {
    if (user?.spotify) {
      if (user.spotify.timestamps.end !== endTimestamp) {
        startedTimestamp = user.spotify.timestamps.start;
        endTimestamp = user.spotify.timestamps.end;
        const interval = setInterval(() => {
          if (Date.now() >= endTimestamp || startedTimestamp !== user?.spotify?.timestamps.start || !user?.spotify) {
            clearInterval(interval);
          } else {
            const currentTime = Date.now() - startedTimestamp;
            setElapsed(new Date(currentTime));
            updateCurrentLyric(currentTime);
          }
        }, 100); // Reduzido para 100ms para maior precisão

        return () => {
          clearInterval(interval);
          startedTimestamp = 0;
          endTimestamp = 0;
        };
      }
    } else {
      setLastPlayed(defaultSong);
    }
  }, [user]);

  useEffect(() => {
    if (user?.spotify) {
      fetchLyrics(
        user.spotify.artist,
        user.spotify.song,
        user.spotify.album,
        user.spotify.timestamps.end - user.spotify.timestamps.start
      );
    }
  }, [user?.spotify?.song]);

  useEffect(() => {
    if (!user?.spotify || timestampsRef.current.initialized) return;

    const calculateProgress = () => {
      const { start, end } = timestampsRef.current;
      if (!start || !end) return 0;
      const progress = 100 - (100 * (end - Date.now())) / (end - start);
      return Math.min(Math.max(progress, 0), 100); // Clamp between 0 and 100
    };

    timestampsRef.current = {
      start: user.spotify.timestamps.start,
      end: user.spotify.timestamps.end,
      initialized: true
    };

    const interval = setInterval(() => {
      const currentProgress = calculateProgress();
      setProgress(currentProgress);
      
      if (Date.now() >= timestampsRef.current.end) {
        clearInterval(interval);
      } else {
        const currentTime = Date.now() - timestampsRef.current.start;
        setElapsed(new Date(currentTime));
        updateCurrentLyric(currentTime);
      }
    }, 100);

    return () => {
      clearInterval(interval);
      timestampsRef.current = { start: 0, end: 0, initialized: false };
    };
  }, [user?.spotify?.timestamps.end]);

  useEffect(() => {
    setCurrentLyricIndex(0);
  }, [user?.spotify?.song]);

  return (
    <div
      className={twMerge(
        "group h-auto select-none p-4 hue-rotate-15 backdrop-blur md:h-56 w-2/4 self-center bg-black/50 rounded-md",
        props.className
      )}
    >
      {user ? (
        <div className="lights flex w-full flex-col">
          <div className="flex flex-row gap-4">
            <Image
              quality={50}
              src={user?.spotify?.album_art_url || lastPlayed?.track?.album?.images?.[0]?.url || ""}
              height={94}
              width={94}
              className="h-32 w-32 select-none justify-self-start rounded-lg"
              alt="album cover"
            />
            <div className="flex flex-col justify-center w-full">
              <h2 className="truncate text-3xl font-semibold leading-tight text-pink-100">
                {user?.spotify?.song || lastPlayed?.track?.name}
              </h2>
              <h4 className="truncate text-lg leading-tight text-pink-100 opacity-80">
                by {user?.spotify?.artist || lastPlayed?.track?.artists?.[0]?.name}
              </h4>
              <h4 className="truncate text-lg leading-tight text-pink-100 opacity-80">
                on {user?.spotify?.album || lastPlayed?.track?.album?.name}
              </h4>
              <div className="flex flex-row gap-4 pt-4 w-full items-center justify-center -translate-x-8">
                <SkipBackIcon size={40} className="cursor-pointer" onClick={skipBack} />
                {user?.spotify ? (
                  <PauseIcon size={40} className="cursor-pointer" onClick={pauseMusic} />
                ) : (
                  <PlayIcon size={40} className="cursor-pointer" onClick={playMusic} />
                )}
                <SkipForwardIcon size={40} className="cursor-pointer" onClick={skipNext} />
                <Heart size={40} className="cursor-pointer" />
              </div>
            </div>
          </div>

          {user?.spotify ? (
            <div className="mt-4 w-full">
              <div className="relative h-2 w-full rounded-md bg-pink-200/20">
                <span
                  className="absolute h-2 rounded-md bg-pink-200/70"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <div className="mt-1 flex items-center justify-between px-0.5 text-lg text-pink-100">
                {elapsed ? <span>{getMinuteAndSeconds(elapsed)}</span> : <span>00:00</span>}
                {duration ? <span>{getMinuteAndSeconds(duration)}</span> : <span>00:00</span>}
              </div>
            </div>
          ) : (
            <h2 className="mt-2 w-full select-none text-center text-base font-bold tracking-tighter text-pink-200 sm:text-lg">
              {/* {`last played ${moment(lastPlayed?.played_at || "").fromNow()}`} */}
              {`last song played`}
            </h2>
          )}

          {/* Replace the existing lyrics section */}
  {isLoading ? (
    <div className="hue-rotate-15 backdrop-blur bg-black/50 rounded-md mt-4 text-center text-pink-100">
      Loading lyrics...
    </div>
  ) : error ? (
    <div className="hue-rotate-15 backdrop-blur bg-black/50 rounded-md mt-4 text-center text-pink-100/70">
      {error}
    </div>
  ) : lyrics.length > 0 && (
    <>
      {/* Current lyric display */}
      <div className="hue-rotate-15 backdrop-blur bg-black/50 rounded-md mt-4 text-center py-4 relative overflow-hidden h-36">
        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-2 px-4">
          <AnimatePresence mode="popLayout">
            {/* Previous lyric */}
            {currentLyricIndex > 0 && (
              <motion.p
                key={`prev-${currentLyricIndex}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.3, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.5 }}
                className="text-pink-100/30 text-sm font-normal line-clamp-1 w-full"
              >
                {lyrics[currentLyricIndex - 1]?.text}
              </motion.p>
            )}
            
            {/* Current lyric */}
            <motion.p
              key={`current-${currentLyricIndex}`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.5 }}
              className="text-pink-100 text-lg font-semibold line-clamp-2 w-full"
            >
              {currentLyric?.text || "♪ ♪ ♪"}
            </motion.p>
            
            {/* Next lyric */}
            {currentLyricIndex < lyrics.length - 1 && (
              <motion.p
                key={`next-${currentLyricIndex}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.3, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.5 }}
                className="text-pink-100/30 text-sm font-normal line-clamp-1 w-full"
              >
                {lyrics[currentLyricIndex + 1]?.text}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        
        <button
          onClick={() => setIsModalOpen(true)}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 text-sm text-pink-100/70 hover:text-pink-100 transition-colors"
        >
          View full lyrics
        </button>
      </div>

      {/* Full lyrics modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={`${user?.spotify?.song || ''} - Lyrics`}
      >
        <div className="max-h-[60vh] overflow-y-auto scroll-smooth scrollbar-thin scrollbar-track-pink-200/10 scrollbar-thumb-pink-200/30">
          <div className="space-y-2">
            {lyrics.map((lyric, index) => (
              <p
                key={index}
                data-lyric-index={index}
                className={`text-pink-100 transition-all duration-300 ${
                  index === currentLyricIndex
                    ? "text-base font-bold"
                    : "text-sm opacity-50"
                }`}
              >
                {lyric.text}
              </p>
            ))}
          </div>
        </div>
      </Modal>
    </>
  )}
        </div>
      ) : (
        <></>
      )}
    </div>
  );
}
