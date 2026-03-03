//-----------------------------------------------------------------------------
// name: waterMusicContactMicrophones.ck
// date: February 2025
// desc: implements subtractive synthesis to make music from microphone inputs
//       we are using this piece with contact microphones placed in water
//       NOTE: this piece was altered from the blown/microphone instrument & the keyboard/mouse functionality still works
// start up Chuck: To play, 
//      1) Click "Start WebChuck" with yellow button
//      2) Click the microphone icon to start the microphone
//      3) Click play icon to start one instance of the instrument playing
//      4) To stop the running instrument instance, click the minus icon.
// how to play:
//      Connect a microphone and separate speaker. You can use headphones if you don't have a separate speaker.
//      This piece WILL feedback if microphone is too close to speaker. 
//h
//      OPEN IN WEBCHUCK here!! https://tinyurl.com/3j3x4rs7
//
// To add some things with keyboards (kind of weird now but you can still do it!)
//       hit a lettered key (a-z) to select a pitch/note
//       then blow into your microphone to create a note
//       use the keyboard keys to change pitches (eg. notes, pitch is how high or low a note is)
//       move the mouse left to increase the Q -- how pure/noisy sound is (ie, width of the bandwidth filters)
//       move the mouse around to create vibrato in the note while blowing.
//
///--------note from ChucK authors
// note: select between mice/trackpads by specifying device number;
//       to see a list of devices and their numbers, either...
//       1) view the Device Browser window in miniAudicle (select
//          "Human Interface Devices" in the drop-down menu)
//       OR 2) from the command line
//          > chuck --probe
//
// author: Courtney Brown unless otherwise noted, has some bits from chuck examples by Perry Cook & Ge Wang
//-----------------------------------------------------------------------------

//---------------------------
//---------------------------
// Score: SMILE Laptop Water -- actual composition still in process --> Someone please come up with a better name!! :)
//---------------------------
//---------------------------

//handle HID differently based on laptop or webchuck
1 => int USE_LAPTOP; //OR webchuck
0.0 => float deltaX;
0.0 => float deltaY;
0.0 => float lastMouseX;
0.0 => float lastMouseY;

//---------------------------
// MAIN!!! Initialization code
//---------------------------

second/samp => float SRATE; //sample rate
1/SRATE => float T; //the time-step

//---create an envelope follower, code from follower.ck by Perry Cook
// this basically allows the breath to control the sound.
adc => Gain g => OnePole audioInEnvelope => blackhole;
// square the input
adc => g;
// multiply
3 => g.op;
//-- end Perry's code


//an array of bandpass filters -- Courtney again!
//CNoise noise; // noise to go through the bandpass filters
ResonZ bp[5]; //a lot of filters
220 => float freq; //the base frequency of the filters

//put the gain to the dac -- have a limiter to prevent clipping, etc. 
//also added some reverb (JCRev)
Gain gain => JCRev jcRev => Dyno limiter => dac; 
limiter.limit(); //stop the clipping mayhem
0.25 => jcRev.mix; //set the reverb mix

//set the gain, Q, & frequency of the bandpass filters smoothly, with no hiccup -- see class at end of code
SmoothedFloat bpGain(5);
SmoothedFloat bpQ(15.0);
FrequencyVibrato bpFreq(220, 10000); //make changes happen faster in frequency
connectBP(); //connect the band pass filters to noise and gain

//set noise parameters
1 => gain.gain;
//"pink" => noise.mode; 

// webchuck keyboard device    
0 => int device;

// HID (keyboard and mouse) input and HID message
Hid hid;
Hid kb; 
HidMsg msg, msg2;

// open keyboard device
if( !kb.openKeyboard( device ) ) me.exit();
<<< "keyboard '" + hid.name() + "' ready", "" >>>;

// open mouse 0, exit on fail
if( !hid.openMouse( device ) ) me.exit();
<<< "mouse '" + hid.name() + "' ready", "" >>>;

//init midi note mapping
initMidiNotes() @=> int midiNotes[];

//---------------------------
// MAIN!!! Main loop that is the musical instrument
//---------------------------

now => time lastChecked;

while(true) //OMG, this never ends
{
    //"chuck" a millisecond to now & make time go & run everything
    //you must chuck time to make sound!!
    1::ms => now; 
    
    //the amplitude of the audio input changes the gain (volume) of the noise
    //audioInEnvelope.last() * 100 => noise.gain; 

    //update bp filter gain, freq, & Q
    updateBP();

    // wait for mouse or keyboard event to change values in real-time
    keyboardAndMouseInput();
}


//---------------------------
// Functions and classes
//---------------------------

//adds all teh bandpass filters to our signal chain
function connectBP()
{
    for( 0=>int i; i<bp.size(); i++ )
    {
        adc => bp[i]; //set the adc here instead of the noise input so we hear some microphone input!!
        bp[i] => gain;
    } 
    //0 => noise.gain; //start at 0   //not relevant any more.
    updateBP();
}

//---------------------------

//change the frequency of all the band-pass filters
//uses the harmonic series to create a basic timbre via subtractive synthesis
function changeFrequency(float f0)
{
    (SRATE * 0.49) => float fmax; //highest freq is the nyquist
    
    for( 0=>int i; i<bp.size(); i++ )
    {
        f0 * (i+1) => float fi;
        
        if( fi > fmax )
        {
            0 => bp[i].gain; // disable this band
            fmax => bp[i].freq; // keep it sane anyway
        }
        else fi => bp[i].freq;
    }
} 

//---------------------------
// implements keyboard and mouse interactivity
function keyboardAndMouseInput()
{

    250::ms => dur note8th;
    60 => int whichKey;

    // get message
    while( kb.recv( msg ) )
    {
        if( USE_LAPTOP == 1 )
        {
            msg.ascii => whichKey;
        }
        else
        {
            msg.which => whichKey;
        }
        
        updateBP();
        //audioInEnvelope.last() * 100 => noise.gain; 

        // check
        if( msg.isButtonDown() && whichKey > 50 )
        {
            getMidiNote( whichKey  ) => int note;
            Std.mtof( note ) => float freq;
            if( freq > 20000 ) continue;
            
            <<< "msg.which: " + whichKey + " note: " + note + " freq: " + freq >>>;

            bpFreq.set(freq);
        
         }

    }
    if( USE_LAPTOP == 1 )
    {
        clamp(MouseCursor.scaled().x) - lastMouseX => deltaX; //not scaled... 
        clamp(MouseCursor.scaled().y) - lastMouseY => deltaY; //not scaled... 
        clamp(MouseCursor.scaled().x) => lastMouseX; 
        clamp(MouseCursor.scaled().y) => lastMouseY; 
        bpQ.set( clampTo(50*clamp(MouseCursor.scaled().x) + 0.2, 0.2, 50.0) ); 
        <<< "Q:", 50*clamp(MouseCursor.scaled().x) + 0.2 >>>;
    }
    else
    {
        bpQ.set( 15.0 ); //fix for webchuck         
    }
    
    
//uncomment to change notes randomly on the 8th note - C minor
/*
     if( now - lastChecked >= note8th )
    {
        //Currently, this is all in C harmonic minor
        [60, 62, 63, 65, 67, 68, 71, 72, 74,
        72, 74, 75, 77, 79, 80, 83, 84, 86, 87,
        48, 50, 51, 53, 55, 56, 59, 60] @=> int mid[];  
        
            now => lastChecked;
            Math.random2(0, mid.size()-1) => int i;
            mid[i] => int note;
            Std.mtof( note - 12 ) => float freq;
            if( freq < 20000 ) 
            {
                <<<"random note!! " +" note: " + note + " freq: " + freq >>>;

                bpFreq.set(freq);
            }
        
    }
*/ 

//this has to be written using updated Chuck for desktop/etc. using --> MouseCursor.xy(), MouseCursor.scaled()
//or it will run in webchuck
/*
while( hid.recv( msg2 ) )
{
    // mouse motion
    if( msg.isMouseMotion() )
    {
        //map x to Q & y to volume
        //bpQ.set( 500*msg.scaledCursorX + 30 ); //not doing this
        //bpGain.set(Math.fabs( (1-msg.scaledCursorY)*4) ); //not doing this
        
        //map vibrato to mouse movement
        //Take the power of the signal                                  
        (Math.sqrt(msg.deltaY*msg.deltaY + msg.deltaX*msg.deltaX) / 5) => float vibrato;
        Math.min(vibrato, 0.1*bpFreq.actualNote()) => vibrato; //limit vibrato to a 10% change in the note
        if( msg.deltaX != 0 ) //fix for noise
        {
            vibrato * msg.deltaX/msg.deltaX => vibrato; //add back direction
        }
        bpFreq.vibrato(msg.deltaX/25);
        <<<"mousemovement!! mouse deltaX:", msg.deltaX >>>;
    }
}
*/
}

function float clamp(float v)
{
    return clampTo(v, 0, 1);
}
    
    
function float clampTo(float v, float lo, float hi)
{
    if(v < lo) return lo;
    if(v > hi) return hi;
    return v;
}    
//---------------------------

//modify the gain of bandpass filters
function updateBP()
{
    bpGain.update(); 
    bpQ.update();
    bpFreq.update();

    changeFrequency(bpFreq.get());

    //setting the gain & Q
    for( 0=>int i; i<bp.size(); i++ )
    {
        bpGain.get() / (i + 1.0) => bp[i].gain;
        bpQ.get() => bp[i].Q;
        //15.0 => bp[i].Q; //change the Q so that we hear some water
    }  
}

//---------------------------
//class SmoothedVariable
//this is for a float that needs to change for sound parameters
//it changes the float over time smoothly so there are no clicks, etc. noise
class SmoothedFloat
{         
    0 => float curVal; //the variable to change
    0 => float dT; //the 1st derivative change over time (ie, the infinitesimal, but not infinit lol)
    500 => float modT; //a modification to the time-step
    0 => float goalVal; //the goal value

    function SmoothedFloat()
    {
        //do nothing keep default values
    }

    //set the initial value
    function SmoothedFloat(float v)
    {
        v => curVal;
        v => goalVal;
    }

    //set the initial value & mod
    function SmoothedFloat(float v, float mod)
    {
        v => curVal;
        v => goalVal;
        mod => modT;
    }

    //this will start changing the val to reach the goal value
    function set(float v)
    {
        v => goalVal; 
    }

    //this will update the value as time passes so it heads towards the goal value
    function update()
    {
        goalVal - curVal => float diff;
        (dT + diff)*T*modT => dT ; 
        curVal + dT => curVal; 
    }

    //return the current value
    function float get()
    {
        return curVal;
    }

    //make the value change faster or slower
    function setModT(float m)
    {
        m => modT;
    }
}
//---------------------------
//---------------------------

//This class extends the smoothed float and allows vibrato change around it.
class FrequencyVibrato extends SmoothedFloat
{
    220 => float actualFreq; 
    0 => float addOnFreq;

    function FrequencyVibrato(float v, float mod)
    {
        setFreq(v);
        mod => modT;
    }

    function setFreq(float f)
    {
        set(f);
        f => actualFreq;
    }

    //add the f parameter to change the frequency w/no smoothing
    function vibrato(float f)
    {
        actualFreq + f => curVal;
        actualFreq + f => goalVal;    
    }

    //this will start changing the val to reach the goal value
    function set(float v)
    {
        v => goalVal;
        v => actualFreq;
    }

    function float actualNote()
    {
        return actualFreq;
    }

    //this will update the value as time passes so it heads towards the goal value
    function update()
    {
        goalVal - curVal => float diff;

        //don't allow large diffs as this will lead to clicking
        while (diff > 50)
        {
            diff / 2 => diff;
        }
     
        (dT + diff)*T*modT => dT ; 
        curVal + dT => curVal; 
    }
}

//---------------------------
//creates the midi note associative array to play the piece in C Harmonic Minor
function int[] initMidiNotes()
{
    //maps all the midi to ascii letters
    ["A", "S", "D", "F", "G", "H", "J", "K", "L", 
     "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", 
     "Z", "X", "C", "V", "B", "N", "M", ","]  @=> string ascii[]; 
    [60, 62, 63, 65, 67, 68, 71, 72, 74,
     72, 74, 75, 77, 79, 80, 83, 84, 86, 87,
     48, 50, 51, 53, 55, 56, 59, 60] @=> int mid[];  
    int midiNotes[mid.size()];

    for( 0=>int i; i<ascii.size(); i++ )
    {
        mid[i] => midiNotes[ascii[i]];
    }
    return midiNotes;
}
//---------------------------
//given an ascii value from the keyboard, get the note
function int getMidiNote(int ascii)
{
    "" => string i;
    if( ascii != 188 )
    {
        i.appendChar(ascii);
    }
    else "," => i;

    midiNotes[i] => int note;
    return note;
}
