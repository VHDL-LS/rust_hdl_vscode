-- Package env as defined by IEEE 1076-2008

package ENV is

    procedure STOP (STATUS: INTEGER);
    procedure STOP;

    procedure FINISH (STATUS: INTEGER);
    procedure FINISH;

    function RESOLUTION_LIMIT return DELAY_LENGTH;

end package ENV;
